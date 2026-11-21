/**
 * Accelerators, server side (owner, 2026-11-21) — see src/core/accelerators.ts
 * for the model. This file owns the files and the outside world:
 *
 *   data/accelerators/accelerators.json  the list (no secrets)
 *   <auth dir>/accelerator-keys.json     RunPod key, Modal token (0600; never settings.json)
 *   data/accelerators/id_ed25519         the app's own SSH key, for cloud pods only
 *   data/accelerators/known_hosts-<pod>  each cloud pod's host key, deleted with the pod (RunPod reuses
 *                                        IP:port mappings, so one shared file would refuse the next pod)
 *   data/accelerators/runpod-pods.json   every pod the app created, written BEFORE it boots;
 *                                        after a restart any pod still listed is an orphan → terminated
 *   data/accelerators/modal-venv         the Modal SDK (installed from Settings)
 *
 * `openTransport` turns an accelerator into a KernelSpec — the process the
 * code runner spawns — provisioning cloud machines first when needed.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTH_FILE, PATHS } from "../../config.ts";
import {
	AcceleratorError,
	KERNEL_READY,
	MODAL_BRIDGE,
	RUNPOD_API,
	driverBootstrap,
	modalBridgeConfig,
	parseAccelerator,
	remoteKernelCommand,
	runpodCreateBody,
	runpodPodView,
	sshArgs,
	sshConfigHosts,
	type Accelerator,
	type ModalAccelerator,
	type RunPodAccelerator,
	type SshAccelerator,
	type SshTarget,
} from "../core/accelerators.ts";

const dir = () => PATHS.accelerators;
const LIST_FILE = () => path.join(/* turbopackIgnore: true */ dir(), "accelerators.json");
const KEYS_FILE = path.join(/* turbopackIgnore: true */ path.dirname(AUTH_FILE), "accelerator-keys.json");
const APP_KEY = () => path.join(/* turbopackIgnore: true */ dir(), "id_ed25519");
const knownHosts = (podId: string) => path.join(/* turbopackIgnore: true */ dir(), `known_hosts-${podId.replace(/[^\w-]/g, "_")}`);
const POD_LEDGER = () => path.join(/* turbopackIgnore: true */ dir(), "runpod-pods.json");
const MODAL_VENV = () => path.join(/* turbopackIgnore: true */ dir(), "modal-venv");
const modalPython = () => path.join(/* turbopackIgnore: true */ MODAL_VENV(), "bin", "python");

function writeJson(file: string, value: unknown, mode?: number): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, "\t"), mode ? { mode } : {});
	fs.renameSync(tmp, file);
}
function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

// ─── The list ───────────────────────────────────────────────────────────────

export function listAccelerators(): Accelerator[] {
	const raw = readJson<unknown>(LIST_FILE(), []);
	return Array.isArray(raw) ? (raw as Accelerator[]) : [];
}

export function getAccelerator(id: string | undefined | null): Accelerator | null {
	if (!id) return null;
	return listAccelerators().find((a) => a.id === id) ?? null;
}

export function createAccelerator(body: Record<string, unknown>): Accelerator {
	const acc = parseAccelerator(body, `acc_${randomUUID().slice(0, 8)}`);
	writeJson(LIST_FILE(), [...listAccelerators(), acc]);
	return acc;
}

export function updateAccelerator(id: string, body: Record<string, unknown>): Accelerator {
	const list = listAccelerators();
	const i = list.findIndex((a) => a.id === id);
	if (i < 0) throw new AcceleratorError(`No accelerator [${id}].`);
	const next = parseAccelerator(body, id, list[i]);
	list[i] = next;
	writeJson(LIST_FILE(), list);
	return next;
}

export function deleteAccelerator(id: string): boolean {
	const list = listAccelerators();
	const next = list.filter((a) => a.id !== id);
	if (next.length === list.length) return false;
	writeJson(LIST_FILE(), next);
	return true;
}

// ─── Keys (BYOK) ────────────────────────────────────────────────────────────

interface Keys {
	runpodApiKey?: string;
	modalTokenId?: string;
	modalTokenSecret?: string;
}
const readKeys = (): Keys => readJson<Keys>(KEYS_FILE, {});

export interface AcceleratorKeyStatus {
	runpod: boolean;
	modal: boolean;
}
export function acceleratorKeyStatus(): AcceleratorKeyStatus {
	const k = readKeys();
	return { runpod: Boolean(k.runpodApiKey), modal: Boolean(k.modalTokenId && k.modalTokenSecret) };
}

/** Set (non-empty string) or clear (null) each key the body names. */
export function setAcceleratorKeys(body: Record<string, unknown>): AcceleratorKeyStatus {
	const next: Keys = { ...readKeys() };
	for (const k of ["runpodApiKey", "modalTokenId", "modalTokenSecret"] as const) {
		const v = body[k];
		if (v === null) delete next[k];
		else if (typeof v === "string" && v.trim()) {
			if (/\s/.test(v.trim())) throw new AcceleratorError(`${k} has spaces in it — paste just the key.`);
			next[k] = v.trim();
		}
	}
	writeJson(KEYS_FILE, next, 0o600);
	fs.chmodSync(KEYS_FILE, 0o600);
	return acceleratorKeyStatus();
}

// ─── Small process helpers ──────────────────────────────────────────────────

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ code: number | null; out: string; err: string }> {
	return new Promise((resolve) => {
		let out = "";
		let err = "";
		const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
		const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
		child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
		child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ code: null, out, err: err + e.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out, err });
		});
	});
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new AcceleratorError("Cancelled."));
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			reject(new AcceleratorError("Cancelled."));
		}, { once: true });
	});

/** The app's own key for cloud pods (made once; never the user's ~/.ssh keys). */
async function appPublicKey(): Promise<string> {
	const key = APP_KEY();
	if (!fs.existsSync(key)) {
		fs.mkdirSync(path.dirname(key), { recursive: true });
		const r = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "socratech-accelerators", "-f", key]);
		if (r.code !== 0) throw new AcceleratorError(`Could not make an SSH key (ssh-keygen): ${r.err.trim() || r.code}`);
	}
	return fs.readFileSync(`${key}.pub`, "utf8").trim();
}

/** ssh's ~ only; ssh itself expands ~ in its config, not on the command line we build. */
const expandHome = (p: string) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

export function sshHostSuggestions(): string[] {
	try {
		return sshConfigHosts(fs.readFileSync(path.join(os.homedir(), ".ssh", "config"), "utf8"));
	} catch {
		return [];
	}
}

// ─── Modal SDK ──────────────────────────────────────────────────────────────

export function modalInstalled(): boolean {
	return fs.existsSync(modalPython());
}

export async function installModal(): Promise<boolean> {
	if (!modalInstalled()) {
		fs.mkdirSync(dir(), { recursive: true });
		const v = await run("python3", ["-m", "venv", MODAL_VENV()], { timeoutMs: 120_000 });
		if (v.code !== 0) throw new AcceleratorError(`python3 -m venv failed: ${(v.err || v.out).trim().slice(-300)}`);
	}
	const pip = await run(path.join(/* turbopackIgnore: true */ MODAL_VENV(), "bin", "pip"), ["install", "-q", "--upgrade", "modal"], { timeoutMs: 600_000 });
	if (pip.code !== 0) throw new AcceleratorError(`pip install modal failed: ${(pip.err || pip.out).trim().slice(-300)}`);
	return modalInstalled();
}

function modalEnv(): NodeJS.ProcessEnv {
	const k = readKeys();
	if (!k.modalTokenId || !k.modalTokenSecret) throw new AcceleratorError("Add your Modal token (Settings → Accelerators).");
	return { ...process.env, MODAL_TOKEN_ID: k.modalTokenId, MODAL_TOKEN_SECRET: k.modalTokenSecret, PYTHONUNBUFFERED: "1" };
}

const modalLog = (name: string) => path.join(/* turbopackIgnore: true */ dir(), "logs", `modal-${name.replace(/[^\w-]/g, "_")}.log`);

// ─── RunPod ─────────────────────────────────────────────────────────────────

async function runpod(pathname: string, init: RequestInit = {}): Promise<unknown> {
	const key = readKeys().runpodApiKey;
	if (!key) throw new AcceleratorError("Add your RunPod API key (Settings → Accelerators).");
	const res = await fetch(`${RUNPOD_API}${pathname}`, {
		...init,
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
	});
	const text = await res.text();
	if (!res.ok) {
		if (res.status === 404 && init.method === "DELETE") return null;
		throw new AcceleratorError(`RunPod ${res.status}: ${text.slice(0, 300) || res.statusText}`);
	}
	return text ? (JSON.parse(text) as unknown) : null;
}

type LedgerPod = { podId: string; journalId: string; acceleratorId: string; createdAt: string };
const readLedger = () => readJson<LedgerPod[]>(POD_LEDGER(), []);
const writeLedger = (pods: LedgerPod[]) => writeJson(POD_LEDGER(), pods);

async function terminatePod(podId: string): Promise<void> {
	await runpod(`/pods/${encodeURIComponent(podId)}`, { method: "DELETE" });
	writeLedger(readLedger().filter((p) => p.podId !== podId));
	fs.rmSync(knownHosts(podId), { force: true });
}

type ReconcileGlobal = { __lhRunpodReconciled?: Promise<void> };
/**
 * Once per server process: any pod still in the ledger was left by a crash
 * or a quit mid-session (live sessions are in-memory, so none survive a
 * restart) — terminate it so it stops billing.
 */
export function reconcileRunPods(): Promise<void> {
	const g = globalThis as typeof globalThis & ReconcileGlobal;
	return (g.__lhRunpodReconciled ??= (async () => {
		for (const pod of readLedger()) {
			try {
				await terminatePod(pod.podId);
				console.log(`[accelerators] terminated orphaned RunPod pod ${pod.podId}`);
			} catch (err) {
				console.warn(`[accelerators] could not terminate RunPod pod ${pod.podId}:`, err instanceof Error ? err.message : err);
			}
		}
	})());
}

/** Pods the app still holds (Settings shows them, with a terminate button). */
export function runpodLedger(): LedgerPod[] {
	return readLedger();
}
export async function terminateRunPod(podId: string): Promise<void> {
	await terminatePod(podId);
}

// ─── Transports ─────────────────────────────────────────────────────────────

export interface KernelSpec {
	cmd: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	/** How long to wait for the driver's READY line once spawned. */
	readyTimeoutMs: number;
	/** SIGTERM first and give it a moment (the Modal bridge terminates its sandbox). */
	gentleKill: boolean;
	/** After the process is gone: release what was provisioned (RunPod: delete the pod). */
	release?: () => Promise<void>;
	/** Shown under the compute picker. */
	where: string;
}

function sshTarget(a: SshAccelerator): SshTarget {
	const extra = a.sshOptions ?? [];
	// Trust a server the first time (like typing "yes"); a CHANGED host key is still refused.
	const hostKey = extra.some((o) => /^StrictHostKeyChecking=/i.test(o)) ? [] : ["StrictHostKeyChecking=accept-new"];
	return {
		host: a.host,
		...(a.user ? { user: a.user } : {}),
		...(a.port ? { port: a.port } : {}),
		...(a.identityFile ? { identityFile: expandHome(a.identityFile) } : {}),
		options: [...hostKey, ...extra],
	};
}

function sshSpec(target: SshTarget, python: string, workdir: string, journalId: string, where: string): KernelSpec {
	return { cmd: "ssh", args: sshArgs(target, remoteKernelCommand(python, workdir, journalId)), readyTimeoutMs: 60_000, gentleKill: false, where };
}

async function openRunPod(a: RunPodAccelerator, journalId: string, onPhase: (p: string) => void, signal?: AbortSignal): Promise<KernelSpec> {
	await reconcileRunPods();
	const publicKey = await appPublicKey();
	onPhase(`creating a RunPod pod (${a.gpuCount}× ${a.gpuType})`);
	const pod = (await runpod("/pods", { method: "POST", body: JSON.stringify(runpodCreateBody(a, journalId, publicKey)) })) as { id?: string } | null;
	const podId = pod?.id;
	if (!podId) throw new AcceleratorError("RunPod did not return a pod id.");
	writeLedger([...readLedger(), { podId, journalId, acceleratorId: a.id, createdAt: new Date().toISOString() }]);
	try {
		const deadline = Date.now() + 15 * 60_000;
		let ssh: { host: string; port: number } | undefined;
		for (;;) {
			const view = runpodPodView(await runpod(`/pods/${encodeURIComponent(podId)}`));
			if (view.status === "ERROR" || view.status === "TERMINATED" || view.status === "EXITED") throw new AcceleratorError(`The pod stopped (${view.status}).`);
			if (view.status === "RUNNING" && view.ssh) {
				ssh = view.ssh;
				break;
			}
			onPhase(`pod ${podId}: ${view.status.toLowerCase()}…`);
			if (Date.now() > deadline) throw new AcceleratorError("The pod did not come up within 15 minutes.");
			await sleep(5_000, signal);
		}
		const target: SshTarget = {
			host: ssh.host,
			port: ssh.port,
			user: "root",
			identityFile: APP_KEY(),
			options: ["StrictHostKeyChecking=accept-new", `UserKnownHostsFile=${knownHosts(podId)}`],
		};
		// sshd starts a little after the pod reports RUNNING.
		onPhase(`pod ${podId} is up — waiting for SSH`);
		const sshDeadline = Date.now() + 3 * 60_000;
		for (;;) {
			const r = await run("ssh", sshArgs(target, "true"), { timeoutMs: 30_000 });
			if (r.code === 0) break;
			if (Date.now() > sshDeadline) throw new AcceleratorError(`SSH to the pod never came up: ${r.err.trim().slice(-300)}`);
			await sleep(5_000, signal);
		}
		return { ...sshSpec(target, "python3", "/workspace", journalId, `RunPod pod ${podId}`), release: () => terminatePod(podId) };
	} catch (err) {
		await terminatePod(podId).catch(() => {});
		throw err;
	}
}

function modalSpec(a: ModalAccelerator, journalId: string): KernelSpec {
	if (!modalInstalled()) throw new AcceleratorError("Install the Modal SDK first (Settings → Accelerators).");
	const log = modalLog(journalId);
	fs.mkdirSync(path.dirname(log), { recursive: true });
	return {
		cmd: modalPython(),
		args: ["-u", "-c", MODAL_BRIDGE, modalBridgeConfig(a, journalId), log],
		env: modalEnv(),
		readyTimeoutMs: 20 * 60_000,
		gentleKill: true,
		where: `Modal sandbox${a.gpu ? ` (${a.gpu})` : ""}`,
	};
}

/** The process to spawn for `a` — provisioning a cloud machine first if it needs one. */
export async function openTransport(a: Accelerator, journalId: string, onPhase: (p: string) => void, signal?: AbortSignal): Promise<KernelSpec> {
	if (a.kind === "ssh") return sshSpec(sshTarget(a), a.python, a.workdir, journalId, a.host);
	if (a.kind === "runpod") return openRunPod(a, journalId, onPhase, signal);
	return modalSpec(a, journalId);
}

/** The local kernel (no accelerator). */
export function localSpec(cwd: string): KernelSpec & { cwd: string } {
	return {
		cmd: process.env.LH_PYTHON || "python3",
		args: ["-u", "-c", driverBootstrap(), cwd],
		env: { ...process.env, PYTHONUNBUFFERED: "1", MPLBACKEND: "Agg" },
		readyTimeoutMs: 30_000,
		gentleKill: false,
		where: "this machine",
		cwd,
	};
}

// ─── Test connection ────────────────────────────────────────────────────────

export interface KernelInfo {
	python?: string;
	host?: string;
	cwd?: string;
	gpus?: string[];
}

/** Start a kernel on `spec`, read its READY line, stop it. */
function probe(spec: KernelSpec): Promise<KernelInfo> {
	return new Promise((resolve, reject) => {
		let out = "";
		let err = "";
		const child = spawn(spec.cmd, spec.args, { env: spec.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
		const timer = setTimeout(() => finish(new AcceleratorError("Timed out waiting for Python to start.")), Math.min(spec.readyTimeoutMs, 90_000));
		let settled = false;
		const finish = (result: KernelInfo | Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stdin.end();
			child.kill(spec.gentleKill ? "SIGTERM" : "SIGKILL");
			if (result instanceof Error) reject(result);
			else resolve(result);
		};
		child.stdout.setEncoding("utf8").on("data", (d: string) => {
			out += d;
			const i = out.indexOf(KERNEL_READY);
			const nl = i >= 0 ? out.indexOf("\n", i) : -1;
			if (nl > 0) {
				try {
					finish(JSON.parse(out.slice(i + KERNEL_READY.length, nl)) as KernelInfo);
				} catch {
					finish(new AcceleratorError("Python started but its hello was garbled."));
				}
			}
		});
		child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
		child.on("error", (e) => finish(new AcceleratorError(e.message)));
		child.on("close", (code) => finish(new AcceleratorError(`exited (${code}): ${err.trim().slice(-400) || "no output"}`)));
	});
}

export function describeInfo(info: KernelInfo): string {
	return [info.python ? `Python ${info.python}` : "", info.host ? `on ${info.host}` : "", info.gpus?.length ? `· ${info.gpus.join(", ")}` : "· no GPU"].filter(Boolean).join(" ");
}

/** "Test" in Settings. SSH: a real kernel start. RunPod / Modal: the key only — never provisions (that costs money). */
export async function testAccelerator(id: string): Promise<{ ok: boolean; detail: string }> {
	const a = getAccelerator(id);
	if (!a) throw new AcceleratorError(`No accelerator [${id}].`);
	try {
		if (a.kind === "ssh") return { ok: true, detail: describeInfo(await probe(sshSpec(sshTarget(a), a.python, a.workdir, "connection-test", a.host))) };
		if (a.kind === "runpod") {
			await appPublicKey();
			const pods = await runpod("/pods");
			const n = Array.isArray(pods) ? pods.length : Array.isArray((pods as { pods?: unknown[] })?.pods) ? (pods as { pods: unknown[] }).pods.length : undefined;
			return { ok: true, detail: `API key works${n !== undefined ? ` (${n} pod${n === 1 ? "" : "s"} on the account)` : ""}. A pod is only created when a notebook connects.` };
		}
		if (!modalInstalled()) return { ok: false, detail: "Install the Modal SDK first." };
		const r = await run(modalPython(), ["-u", "-c", MODAL_BRIDGE, modalBridgeConfig(a, "check", { check: true }), modalLog("check")], { env: modalEnv(), timeoutMs: 90_000 });
		if (r.code === 0 && r.out.includes("ok")) return { ok: true, detail: "Modal token works. A sandbox is only started when a notebook connects." };
		const log = readTail(modalLog("check"));
		return { ok: false, detail: r.err.trim().slice(-300) || (log ? `Modal: ${log}` : `Modal check failed (exit ${r.code})`) };
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

function readTail(file: string): string {
	try {
		return fs.readFileSync(file, "utf8").trim().split("\n").slice(-3).join(" ").slice(-400);
	} catch {
		return "";
	}
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/** Route wrapper: AcceleratorError → 400 {error}; anything else → 500. */
export async function acceleratorRoute(fn: () => Response | Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: err instanceof AcceleratorError ? 400 : 500 });
	}
}

/** Everything Settings → Accelerators shows. Never a secret. */
export function acceleratorOverview() {
	void reconcileRunPods().catch(() => {});
	return {
		accelerators: listAccelerators(),
		keys: acceleratorKeyStatus(),
		modalInstalled: modalInstalled(),
		sshHosts: sshHostSuggestions(),
		pods: runpodLedger(),
	};
}
