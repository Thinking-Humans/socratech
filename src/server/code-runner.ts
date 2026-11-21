/**
 * Journal code execution (owner, 2026-11-15 — reverses D8; accelerators
 * 2026-11-21). The learner's own code, on their own machine or on an
 * accelerator they connected (src/core/accelerators.ts): the API gate
 * (proxy.ts — Host check + cross-site write refusal) keeps other pages out.
 *
 *   python  ONE persistent kernel per journal: cells share globals, the last
 *           expression echoes like Jupyter. The kernel is any process whose
 *           stdio runs KERNEL_DRIVER — local `python3`, `ssh host python3`,
 *           a RunPod pod over SSH, or the Modal bridge. Requests are JSON
 *           lines on stdin; stdout/stderr each end a run with a sentinel.
 *   cpp     locally: each cell compiles alone (`g++ -std=c++20`) and runs
 *           once. On an accelerator the driver compiles + runs it there.
 *
 * Runs are serialized per journal; every run has a time limit (60 s local,
 * the accelerator's own limit remote). A timeout or Stop interrupts
 * (KeyboardInterrupt), then kills the kernel — its state is gone and the
 * output says so. Remote sessions stop after their idle limit and release
 * what they provisioned. Registry lives on globalThis so dev-server hot
 * reloads never orphan a kernel.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { KERNEL_PHASE, KERNEL_READY, type Accelerator } from "../core/accelerators.ts";
import type { RunnableLang } from "../core/journal-code.ts";
import { localSpec, openTransport, type KernelInfo, type KernelSpec } from "./accelerators.ts";

export interface RunResult {
	/** stdout, then stderr, then any status note ("[exit code 1]"). */
	output: string;
	ok: boolean;
	/** The journal's run counter after this run — Jupyter's [n]. */
	executionCount: number;
	ms: number;
}

export interface RunOptions {
	/** Default: 60 s for local Python, 10 s for a local C++ program (compile gets its own 60 s); the accelerator's limit remote. */
	timeoutMs?: number;
	/** Run there instead of on this machine. */
	accelerator?: Accelerator | null;
	/** For the live status (which cell is running). */
	cellId?: string;
}

const OUTPUT_CAP = 100_000;
const PY_TIMEOUT_MS = 60_000;
const CPP_COMPILE_TIMEOUT_MS = 60_000;
const CPP_RUN_TIMEOUT_MS = 10_000;
const INTERRUPT_GRACE_MS = 2_000;
const REMOTE_INTERRUPT_GRACE_MS = 10_000;

function cap(text: string): string {
	return text.length <= OUTPUT_CAP ? text : `${text.slice(0, OUTPUT_CAP)}\n… [output truncated: ${text.length - OUTPUT_CAP} more characters]`;
}

function join(...parts: string[]): string {
	return parts
		.map((p) => p.replace(/\s+$/, ""))
		.filter(Boolean)
		.join("\n");
}

/** Where a journal's code runs locally — files it writes persist there. */
export function journalWorkDir(journalId: string): string {
	const dir = path.join(PATHS.data, "journal-work", journalId.replace(/[^\w-]/g, "_"));
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function quiet(child: ChildProcess): void {
	// Never hold the server (or a test run) open on a kernel's handles.
	child.unref();
	for (const s of [child.stdin, child.stdout, child.stderr]) (s as unknown as { unref?: () => void } | null)?.unref?.();
}

// ─── Kernel (any transport) ─────────────────────────────────────────────────

class Kernel {
	private readonly proc: ChildProcess;
	private readonly spec: KernelSpec;
	private out = "";
	private err = "";
	private booting = true;
	private pending: { sentinel: string; done: (status: "ok" | "err" | "died") => void } | null = null;
	private killTimer: NodeJS.Timeout | undefined;
	dead = false;
	/** Resolves with the machine's hello once the driver is up. */
	readonly ready: Promise<KernelInfo>;

	constructor(spec: KernelSpec, onPhase: (phase: string) => void) {
		this.spec = spec;
		this.proc = spawn(spec.cmd, spec.args, {
			...((spec as { cwd?: string }).cwd ? { cwd: (spec as { cwd?: string }).cwd } : {}),
			stdio: ["pipe", "pipe", "pipe"],
			env: spec.env ?? process.env,
		});
		quiet(this.proc);
		let readyResolve!: (i: KernelInfo) => void;
		let readyReject!: (e: Error) => void;
		this.ready = new Promise((res, rej) => {
			readyResolve = res;
			readyReject = rej;
		});
		this.ready.catch(() => {});
		const readyTimer = setTimeout(() => {
			readyReject(new Error(`timed out after ${Math.round(spec.readyTimeoutMs / 1000)}s waiting for Python to start${this.bootError()}`));
			this.kill();
		}, spec.readyTimeoutMs);
		this.proc.stdout!.setEncoding("utf8").on("data", (d: string) => {
			this.out += d;
			if (this.booting) {
				// Before READY: progress lines from the bridge, and any login-shell noise (dropped).
				for (;;) {
					const nl = this.out.indexOf("\n");
					if (nl < 0) break;
					const line = this.out.slice(0, nl);
					this.out = this.out.slice(nl + 1);
					const p = line.indexOf(KERNEL_PHASE);
					if (p >= 0) onPhase(line.slice(p + KERNEL_PHASE.length).trim());
					const r = line.indexOf(KERNEL_READY);
					if (r >= 0) {
						this.booting = false;
						clearTimeout(readyTimer);
						this.err = "";
						let info: KernelInfo = {};
						try {
							info = JSON.parse(line.slice(r + KERNEL_READY.length)) as KernelInfo;
						} catch {
							/* an unreadable hello still means it is up */
						}
						readyResolve(info);
						break;
					}
				}
				if (this.booting) return;
			}
			this.check();
		});
		this.proc.stderr!.setEncoding("utf8").on("data", (d: string) => {
			this.err += d;
			if (!this.booting) this.check();
		});
		this.proc.stdin!.on("error", () => {
			/* EPIPE when the process is already gone — exit handles it */
		});
		this.proc.on("error", (e) => {
			this.err += `\n${e.message}`;
			this.die();
		});
		this.proc.on("exit", () => {
			clearTimeout(readyTimer);
			if (this.booting) readyReject(new Error(`exited before Python started${this.bootError()}`));
			this.die();
		});
	}

	private bootError(): string {
		const e = this.err.trim();
		return e ? `: ${e.split("\n").slice(-4).join(" ").slice(-500)}` : "";
	}

	private die(): void {
		this.dead = true;
		clearTimeout(this.killTimer);
		this.pending?.done("died");
		this.pending = null;
	}

	private check(): void {
		const p = this.pending;
		if (!p) return;
		const o = this.out.indexOf(`${p.sentinel}:`);
		const e = this.err.indexOf(p.sentinel);
		if (o < 0 || e < 0) return;
		const status = this.out.slice(o + p.sentinel.length + 1).startsWith("ok") ? "ok" : "err";
		this.pending = null;
		p.done(status);
	}

	/** Captured output so far, and reset. */
	private take(sentinel?: string): { out: string; err: string } {
		const cut = (s: string, mark: string) => {
			const i = sentinel ? s.indexOf(mark) : -1;
			return i < 0 ? s : s.slice(0, i);
		};
		const r = { out: cut(this.out, `${sentinel}:`), err: cut(this.err, sentinel ?? "") };
		this.out = "";
		this.err = "";
		return r;
	}

	/** The running cell's output so far (the live view). */
	partial(): string {
		const strip = (s: string) => s.replace(/\u001e[0-9a-f-]{36}(:\w+)?\n?/g, "");
		return cap(join(strip(this.out), strip(this.err)));
	}

	private send(msg: unknown): void {
		if (!this.dead) this.proc.stdin!.write(`${JSON.stringify(msg)}\n`);
	}

	/** KeyboardInterrupt in the running cell; kill (state reset) if it does not stop within `graceMs`. */
	interrupt(graceMs: number, onKill?: () => void): void {
		if (!this.pending) return;
		this.send({ interrupt: true });
		clearTimeout(this.killTimer);
		this.killTimer = setTimeout(() => {
			if (!this.pending) return;
			onKill?.();
			this.kill();
		}, graceMs);
	}

	run(code: string, lang: RunnableLang, timeoutMs: number, graceMs: number): Promise<{ output: string; ok: boolean; reset: boolean }> {
		const sentinel = `\u001e${randomUUID()}`;
		return new Promise((resolve) => {
			let note = "";
			const secs = Math.round(timeoutMs / 1000);
			const limit = secs >= 120 ? `${Math.round(secs / 60)} min` : `${secs}s`;
			const timer = setTimeout(() => {
				note = `[timed out after ${limit} — interrupted]`;
				this.interrupt(graceMs, () => (note = `[timed out after ${limit} — Python state reset]`));
			}, timeoutMs);
			this.pending = {
				sentinel,
				done: (status) => {
					clearTimeout(timer);
					clearTimeout(this.killTimer);
					const { out, err } = this.take(sentinel);
					const stopped = this.stopNote;
					this.stopNote = "";
					if (status === "died") {
						resolve({ output: cap(join(out, err, note || stopped || "[Python process exited — state reset]")), ok: false, reset: true });
					} else resolve({ output: cap(join(out, err, note || stopped)), ok: status === "ok" && !note && !stopped, reset: false });
				},
			};
			this.send({ code, sentinel, lang });
		});
	}

	/** Set by a user Stop: the note the interrupted run ends with. */
	stopNote = "";

	/** End the process: stdin EOF (the remote driver exits on it), then signals. */
	kill(): void {
		if (this.dead) return;
		try {
			this.proc.stdin!.end();
		} catch {
			/* already closed */
		}
		this.proc.kill(this.spec.gentleKill ? "SIGTERM" : "SIGKILL");
		const hard = setTimeout(() => {
			if (!this.dead) this.proc.kill("SIGKILL");
		}, this.spec.gentleKill ? 8_000 : 1_000);
		hard.unref?.();
	}

	/** Process exit: no waiting — SIGTERM lets the Modal bridge end its sandbox. */
	killNow(): void {
		if (!this.dead) this.proc.kill(this.spec.gentleKill ? "SIGTERM" : "SIGKILL");
	}
}

// ─── Plain processes (C++) ──────────────────────────────────────────────────

function runProcess(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ out: string; err: string; code: number | null; signal: string | null; timedOut: boolean; spawnError?: string }> {
	return new Promise((resolve) => {
		let out = "";
		let err = "";
		let timedOut = false;
		const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.setEncoding("utf8").on("data", (d: string) => {
			if (out.length <= OUTPUT_CAP) out += d;
		});
		child.stderr.setEncoding("utf8").on("data", (d: string) => {
			if (err.length <= OUTPUT_CAP) err += d;
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ out, err, code: null, signal: null, timedOut, spawnError: e.message });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ out, err, code, signal, timedOut });
		});
	});
}

async function runCpp(code: string, workDir: string, timeoutMs: number): Promise<{ output: string; ok: boolean }> {
	const build = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cpp-"));
	try {
		fs.writeFileSync(path.join(build, "main.cpp"), code);
		const exe = path.join(build, process.platform === "win32" ? "main.exe" : "main");
		const cxx = process.env.LH_CXX || "g++";
		const c = await runProcess(cxx, ["-std=c++20", "-O1", "-pipe", "-o", exe, "main.cpp"], build, CPP_COMPILE_TIMEOUT_MS);
		if (c.spawnError) return { output: `[could not start the C++ compiler "${cxx}": ${c.spawnError}]`, ok: false };
		if (c.code !== 0) {
			return { output: cap(join(c.out, c.err, c.timedOut ? "[compile timed out]" : "[compile failed]")), ok: false };
		}
		const r = await runProcess(exe, [], workDir, timeoutMs);
		const note = r.timedOut
			? `[timed out after ${Math.round(timeoutMs / 1000)}s]`
			: r.signal
				? `[killed by ${r.signal}]`
				: r.code !== 0
					? `[exit code ${r.code}]`
					: "";
		// Compiler warnings come first, like a terminal would show them.
		return { output: cap(join(c.err, r.out, r.err, note)), ok: !note };
	} finally {
		fs.rmSync(build, { recursive: true, force: true });
	}
}

// ─── Registry ───────────────────────────────────────────────────────────────

interface Session {
	kernel?: Kernel;
	/** A kernel being connected (cloud provisioning can take minutes). */
	opening?: Promise<Kernel>;
	abort?: AbortController;
	/** What `kernel` was started on (null = this machine). */
	accelerator: Accelerator | null;
	release?: () => Promise<void>;
	count: number;
	queue: Promise<unknown>;
	phase?: string;
	error?: string;
	info?: KernelInfo;
	where?: string;
	running?: { cellId?: string; startedAt: number };
	idleTimer?: NodeJS.Timeout;
	idleStopAt?: number;
	/** Said once, at the top of the next run's output. */
	notice?: string;
}

const REGISTRY_KEY = Symbol.for("socratech.codeRunner.sessions");
const g = globalThis as unknown as { [REGISTRY_KEY]?: Map<string, Session> };
const sessions: Map<string, Session> = (g[REGISTRY_KEY] ??= (() => {
	const map = new Map<string, Session>();
	process.once("exit", () => {
		for (const s of map.values()) s.kernel?.killNow();
	});
	return map;
})());

function session(journalId: string, accelerator: Accelerator | null): Session {
	let s = sessions.get(journalId);
	if (s && (s.accelerator?.id ?? null) !== (accelerator?.id ?? null)) {
		// Switched machines: state can't move — end the old session.
		endSession(journalId);
		s = undefined;
	}
	if (!s) sessions.set(journalId, (s = { accelerator, count: 0, queue: Promise.resolve() }));
	else if (accelerator) s.accelerator = accelerator; // edited settings apply from the next connect
	return s;
}

function release(s: Session): void {
	const r = s.release;
	s.release = undefined;
	if (r) void r().catch((err) => console.warn("[accelerators] release failed:", err instanceof Error ? err.message : err));
}

/** Kill the kernel, cancel a connect in flight, release cloud machines; forget the session. */
function endSession(journalId: string): void {
	const s = sessions.get(journalId);
	if (!s) return;
	clearTimeout(s.idleTimer);
	s.abort?.abort();
	s.kernel?.kill();
	release(s);
	sessions.delete(journalId);
}

const label = (a: Accelerator | null) => (a ? a.name : "this machine");

/** The session's live kernel, connecting one if needed. */
function kernelFor(journalId: string, s: Session): Promise<Kernel> {
	if (s.kernel && !s.kernel.dead) return Promise.resolve(s.kernel);
	if (s.kernel?.dead) {
		// Died between runs (connection dropped, idle-stopped elsewhere): state is gone.
		if (s.count > 0) s.notice = `[the session on ${label(s.accelerator)} ended — variables were reset]`;
		s.kernel = undefined;
		s.count = 0;
		release(s);
	}
	if (s.opening) return s.opening;
	const abort = new AbortController();
	s.abort = abort;
	s.error = undefined;
	s.phase = s.accelerator ? `connecting to ${s.accelerator.name}` : undefined;
	const opening = (async () => {
		const spec = s.accelerator ? await openTransport(s.accelerator, journalId, (p) => (s.phase = p), abort.signal) : localSpec(journalWorkDir(journalId));
		s.release = spec.release;
		if (abort.signal.aborted) throw new Error("cancelled");
		const kernel = new Kernel(spec, (p) => (s.phase = p));
		s.kernel = kernel;
		s.where = spec.where;
		s.info = await kernel.ready;
		s.phase = undefined;
		return kernel;
	})();
	s.opening = opening;
	opening.then(
		() => {
			if (s.opening === opening) s.opening = undefined;
		},
		(err: unknown) => {
			if (s.opening === opening) s.opening = undefined;
			s.phase = undefined;
			s.error = err instanceof Error ? err.message : String(err);
			s.kernel?.kill();
			s.kernel = undefined;
			release(s);
		},
	);
	return opening;
}

function armIdleStop(journalId: string, s: Session): void {
	clearTimeout(s.idleTimer);
	s.idleStopAt = undefined;
	const min = s.accelerator?.idleStopMin ?? 0;
	if (!s.accelerator || min <= 0) return;
	s.idleStopAt = Date.now() + min * 60_000;
	s.idleTimer = setTimeout(() => {
		if (sessions.get(journalId) !== s || s.running) return;
		const hadState = s.count > 0;
		s.kernel?.kill();
		s.kernel = undefined;
		release(s);
		s.count = 0;
		s.idleStopAt = undefined;
		if (hadState) s.notice = `[${s.accelerator!.name} was stopped after ${min} min idle — variables were reset]`;
	}, min * 60_000);
	s.idleTimer.unref?.();
}

/** Run one cell's code in its journal's session. Serialized per journal. */
export function runCode(journalId: string, lang: RunnableLang, code: string, opts: RunOptions = {}): Promise<RunResult> {
	const acc = opts.accelerator ?? null;
	const s = session(journalId, acc);
	const job = s.queue.then(async (): Promise<RunResult> => {
		const started = Date.now();
		clearTimeout(s.idleTimer);
		s.idleStopAt = undefined;
		s.running = { ...(opts.cellId ? { cellId: opts.cellId } : {}), startedAt: started };
		try {
			let output: string;
			let ok: boolean;
			if (lang === "cpp" && !acc) {
				({ output, ok } = await runCpp(code, journalWorkDir(journalId), opts.timeoutMs ?? CPP_RUN_TIMEOUT_MS));
			} else {
				let kernel: Kernel;
				try {
					kernel = await kernelFor(journalId, s);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return { output: `[could not connect to ${label(acc)}: ${msg}]`, ok: false, executionCount: s.count, ms: Date.now() - started };
				}
				const timeoutMs = opts.timeoutMs ?? (acc ? acc.runTimeoutMin * 60_000 : PY_TIMEOUT_MS);
				const r = await kernel.run(code, lang, timeoutMs, acc ? REMOTE_INTERRUPT_GRACE_MS : INTERRUPT_GRACE_MS);
				if (r.reset) {
					s.kernel = undefined;
					s.count = 0;
					release(s);
				}
				({ output, ok } = r);
			}
			if (s.notice) {
				output = join(s.notice, output);
				s.notice = undefined;
			}
			s.count += 1;
			return { output, ok, executionCount: s.count, ms: Date.now() - started };
		} finally {
			s.running = undefined;
			if (sessions.get(journalId) === s) armIdleStop(journalId, s);
		}
	});
	s.queue = job.catch(() => undefined);
	return job;
}

export interface KernelStatus {
	/** off: nothing running · connecting · ready: idle kernel · running: a cell is running · error: the last connect failed. */
	state: "off" | "connecting" | "ready" | "running" | "error";
	acceleratorId: string | null;
	phase?: string;
	error?: string;
	info?: KernelInfo;
	where?: string;
	running?: { cellId?: string; startedAt: string; output: string };
	idleStopAt?: string;
	executionCount: number;
}

export function kernelStatus(journalId: string): KernelStatus {
	const s = sessions.get(journalId);
	if (!s) return { state: "off", acceleratorId: null, executionCount: 0 };
	const alive = Boolean(s.kernel && !s.kernel.dead);
	const state: KernelStatus["state"] = s.running && alive ? "running" : s.opening ? "connecting" : alive ? "ready" : s.error ? "error" : "off";
	return {
		state,
		acceleratorId: s.accelerator?.id ?? null,
		...(s.phase ? { phase: s.phase } : {}),
		...(s.error && !alive ? { error: s.error } : {}),
		...(alive && s.info ? { info: s.info } : {}),
		...(alive && s.where ? { where: s.where } : {}),
		...(s.running ? { running: { ...(s.running.cellId ? { cellId: s.running.cellId } : {}), startedAt: new Date(s.running.startedAt).toISOString(), output: alive ? s.kernel!.partial() : "" } } : {}),
		...(s.idleStopAt ? { idleStopAt: new Date(s.idleStopAt).toISOString() } : {}),
		executionCount: s.count,
	};
}

/** Connect ahead of the first run (cloud machines take a while). */
export function connectKernel(journalId: string, accelerator: Accelerator | null): KernelStatus {
	const s = session(journalId, accelerator);
	void kernelFor(journalId, s)
		.then(() => {
			if (!s.running) armIdleStop(journalId, s);
		})
		.catch(() => {});
	return kernelStatus(journalId);
}

/** Stop the running cell (KeyboardInterrupt; the kernel is killed if it ignores it). */
export function interruptKernel(journalId: string): boolean {
	const s = sessions.get(journalId);
	if (!s?.running || !s.kernel || s.kernel.dead) return false;
	const kernel = s.kernel;
	kernel.stopNote = "[stopped]";
	kernel.interrupt(s.accelerator ? REMOTE_INTERRUPT_GRACE_MS : INTERRUPT_GRACE_MS, () => (kernel.stopNote = "[stopped — Python state reset]"));
	return true;
}

/** Drop a journal's Python state, reset its run counter, release its machine. */
export function restartKernel(journalId: string): void {
	endSession(journalId);
}

/** Kill every kernel (tests, shutdown). */
export function stopAllKernels(): void {
	for (const id of [...sessions.keys()]) restartKernel(id);
}
