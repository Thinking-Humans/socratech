/**
 * Journal code execution (owner, 2026-11-15 — reverses D8). Local, the
 * learner's own machine, the learner's own code: the API gate (proxy.ts —
 * Host check + cross-site write refusal) is what keeps other pages out.
 *
 *   python  ONE persistent `python3` per journal (a kernel): cells share
 *           globals, the last expression echoes like Jupyter. Requests go in
 *           on fd 3 (stdin stays free and empty); stdout/stderr come back on
 *           their own pipes, each closed off by a per-run sentinel.
 *   cpp     each cell compiles alone (`g++ -std=c++20`) and runs once; C++
 *           cells share no state.
 *
 * Runs are serialized per journal; every run has a time limit. A Python
 * timeout first interrupts (KeyboardInterrupt), then kills the kernel —
 * its state is gone and the output says so. Registry lives on globalThis so
 * dev-server hot reloads never orphan a kernel.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { RunnableLang } from "../core/journal-code.ts";

export interface RunResult {
	/** stdout, then stderr, then any status note ("[exit code 1]"). */
	output: string;
	ok: boolean;
	/** The journal's run counter after this run — Jupyter's [n]. */
	executionCount: number;
	ms: number;
}

export interface RunOptions {
	/** Default: 60 s for Python, 10 s for a C++ program (compile gets its own 60 s). */
	timeoutMs?: number;
}

const OUTPUT_CAP = 100_000;
const PY_TIMEOUT_MS = 60_000;
const CPP_COMPILE_TIMEOUT_MS = 60_000;
const CPP_RUN_TIMEOUT_MS = 10_000;
const INTERRUPT_GRACE_MS = 2_000;

const PY_DRIVER = String.raw`
import ast, linecache, os, sys, json, traceback
req = os.fdopen(3, "r")
g = {"__name__": "__main__", "__builtins__": __builtins__}
n = 0
for line in req:
    msg = json.loads(line)
    code, sent = msg["code"], msg["sentinel"]
    n += 1
    name = "<cell %d>" % n
    linecache.cache[name] = (len(code), None, code.splitlines(True), name)
    status = "ok"
    try:
        tree = ast.parse(code, name, "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        exec(compile(tree, name, "exec"), g)
        if last is not None:
            v = eval(compile(last, name, "eval"), g)
            if v is not None:
                print(repr(v))
    except BaseException as e:
        status = "err"
        tb = e.__traceback__.tb_next if e.__traceback__ is not None else None
        traceback.print_exception(type(e), e, tb)
    sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__
    sys.stdout.write(sent + ":" + status + "\n"); sys.stdout.flush()
    sys.stderr.write(sent + "\n"); sys.stderr.flush()
`;

function cap(text: string): string {
	return text.length <= OUTPUT_CAP ? text : `${text.slice(0, OUTPUT_CAP)}\n… [output truncated: ${text.length - OUTPUT_CAP} more characters]`;
}

function join(...parts: string[]): string {
	return parts
		.map((p) => p.replace(/\s+$/, ""))
		.filter(Boolean)
		.join("\n");
}

/** Where a journal's code runs — files it writes persist there. */
export function journalWorkDir(journalId: string): string {
	const dir = path.join(PATHS.data, "journal-work", journalId.replace(/[^\w-]/g, "_"));
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function quiet(child: ChildProcess): void {
	// Never hold the server (or a test run) open on a kernel's handles.
	child.unref();
	for (const s of [child.stdout, child.stderr, child.stdio[3]]) (s as unknown as { unref?: () => void } | null)?.unref?.();
}

// ─── Python kernel ──────────────────────────────────────────────────────────

class PythonKernel {
	private readonly proc: ChildProcess;
	private out = "";
	private err = "";
	private pending: { sentinel: string; done: (status: "ok" | "err" | "died") => void } | null = null;
	dead = false;

	constructor(cwd: string) {
		this.proc = spawn(process.env.LH_PYTHON || "python3", ["-u", "-c", PY_DRIVER], {
			cwd,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
			env: { ...process.env, PYTHONUNBUFFERED: "1", MPLBACKEND: "Agg" },
		});
		quiet(this.proc);
		this.proc.stdout!.setEncoding("utf8").on("data", (d: string) => {
			this.out += d;
			this.check();
		});
		this.proc.stderr!.setEncoding("utf8").on("data", (d: string) => {
			this.err += d;
			this.check();
		});
		this.proc.on("error", (e) => {
			this.err += `\n${e.message}`;
			this.die();
		});
		this.proc.on("exit", () => this.die());
	}

	private die(): void {
		this.dead = true;
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

	run(code: string, timeoutMs: number): Promise<{ output: string; ok: boolean; reset: boolean }> {
		const sentinel = `\u001e${randomUUID()}`;
		return new Promise((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			let note = "";
			this.pending = {
				sentinel,
				done: (status) => {
					clearTimeout(timer);
					const { out, err } = this.take(sentinel);
					if (status === "died") {
						resolve({ output: cap(join(out, err, note || "[Python process exited — state reset]")), ok: false, reset: true });
					} else resolve({ output: cap(join(out, err, note)), ok: status === "ok" && !note, reset: false });
				},
			};
			timer = setTimeout(() => {
				note = `[timed out after ${Math.round(timeoutMs / 1000)}s — interrupted]`;
				this.proc.kill("SIGINT");
				timer = setTimeout(() => {
					note = `[timed out after ${Math.round(timeoutMs / 1000)}s — Python state reset]`;
					this.kill();
				}, INTERRUPT_GRACE_MS);
			}, timeoutMs);
			(this.proc.stdio[3] as NodeJS.WritableStream).write(`${JSON.stringify({ code, sentinel })}\n`);
		});
	}

	kill(): void {
		if (!this.proc.killed) this.proc.kill("SIGKILL");
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
	python?: PythonKernel;
	count: number;
	queue: Promise<unknown>;
}

const REGISTRY_KEY = Symbol.for("socratech.codeRunner.sessions");
const g = globalThis as unknown as { [REGISTRY_KEY]?: Map<string, Session> };
const sessions: Map<string, Session> = (g[REGISTRY_KEY] ??= (() => {
	const map = new Map<string, Session>();
	process.once("exit", () => {
		for (const s of map.values()) s.python?.kill();
	});
	return map;
})());

function session(journalId: string): Session {
	let s = sessions.get(journalId);
	if (!s) sessions.set(journalId, (s = { count: 0, queue: Promise.resolve() }));
	return s;
}

/** Run one cell's code in its journal's session. Serialized per journal. */
export function runCode(journalId: string, lang: RunnableLang, code: string, opts: RunOptions = {}): Promise<RunResult> {
	const s = session(journalId);
	const job = s.queue.then(async (): Promise<RunResult> => {
		const started = Date.now();
		let output: string;
		let ok: boolean;
		if (lang === "python") {
			if (!s.python || s.python.dead) s.python = new PythonKernel(journalWorkDir(journalId));
			const r = await s.python.run(code, opts.timeoutMs ?? PY_TIMEOUT_MS);
			if (r.reset) {
				s.python = undefined;
				s.count = 0;
			}
			({ output, ok } = r);
		} else {
			({ output, ok } = await runCpp(code, journalWorkDir(journalId), opts.timeoutMs ?? CPP_RUN_TIMEOUT_MS));
		}
		s.count += 1;
		return { output, ok, executionCount: s.count, ms: Date.now() - started };
	});
	s.queue = job.catch(() => undefined);
	return job;
}

/** Drop a journal's Python state and reset its run counter. */
export function restartKernel(journalId: string): void {
	const s = sessions.get(journalId);
	s?.python?.kill();
	sessions.delete(journalId);
}

/** Kill every kernel (tests, shutdown). */
export function stopAllKernels(): void {
	for (const id of [...sessions.keys()]) restartKernel(id);
}
