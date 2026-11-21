/**
 * Accelerators (owner, 2026-11-21): somewhere other than this machine for a
 * notebook's code to run — your own SSH servers, or bring-your-own-key
 * cloud GPUs (RunPod, Modal). Pure: the types, body validation, the kernel
 * driver every transport runs, the Modal bridge, and the SSH / RunPod
 * request shapes. The processes and HTTP live in src/server/accelerators.ts
 * and src/server/code-runner.ts.
 *
 * One transport model: a process whose stdin / stdout / stderr IS the
 * kernel. Local = `python3`; SSH = `ssh host python3 …`; RunPod = a pod we
 * create, then SSH; Modal = a local bridge relaying a Sandbox process.
 */

export type AcceleratorKind = "ssh" | "runpod" | "modal";

interface AcceleratorBase {
	id: string;
	name: string;
	/** A cell may run this long before it is interrupted (minutes). */
	runTimeoutMin: number;
	/** Stop the remote session after this long without a run (minutes; 0 = never). Cloud GPUs bill while up. */
	idleStopMin: number;
}

export interface SshAccelerator extends AcceleratorBase {
	kind: "ssh";
	/** A Host alias from ~/.ssh/config, or a hostname / IP. */
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	/** How to start Python there — e.g. `python3`, `~/venv/bin/python`, `conda run -n ml python`. */
	python: string;
	/** Where the notebook's code runs on the server (one folder per notebook inside it). */
	workdir: string;
	/** Extra `-o Key=Value` ssh options (ProxyJump, UserKnownHostsFile …); command-running ones are refused. */
	sshOptions?: string[];
}

export interface RunPodAccelerator extends AcceleratorBase {
	kind: "runpod";
	/** A RunPod GPU id, e.g. "NVIDIA GeForce RTX 4090". */
	gpuType: string;
	gpuCount: number;
	cloud: "SECURE" | "COMMUNITY";
	/** A container image that starts sshd from PUBLIC_KEY (RunPod's official images do). */
	image: string;
	diskGb: number;
}

export interface ModalAccelerator extends AcceleratorBase {
	kind: "modal";
	/** Modal GPU spec ("T4", "A10G", "A100", "H100", "L4", "A100-80GB:2" …); empty = CPU only. */
	gpu: string;
	/** Extra pip packages for the sandbox image, space separated. */
	packages: string;
	/** Optional registry image (e.g. "nvidia/cuda:12.4.1-devel-ubuntu22.04"); empty = Modal's debian_slim. */
	image: string;
	pythonVersion: string;
	/** Hard cap on one sandbox's life (minutes). */
	maxLifetimeMin: number;
}

export type Accelerator = SshAccelerator | RunPodAccelerator | ModalAccelerator;

export const ACCELERATOR_KINDS: readonly AcceleratorKind[] = ["ssh", "runpod", "modal"];

export const ACCELERATOR_KIND_LABEL: Record<AcceleratorKind, string> = {
	ssh: "SSH server",
	runpod: "RunPod",
	modal: "Modal",
};

/** Common RunPod GPU ids (suggestions — any id RunPod accepts works). */
export const RUNPOD_GPU_SUGGESTIONS = [
	"NVIDIA GeForce RTX 4090",
	"NVIDIA RTX A5000",
	"NVIDIA RTX A6000",
	"NVIDIA A40",
	"NVIDIA L40S",
	"NVIDIA A100 80GB PCIe",
	"NVIDIA H100 80GB HBM3",
];

export const MODAL_GPU_SUGGESTIONS = ["T4", "L4", "A10G", "L40S", "A100", "A100-80GB", "H100"];

export const DEFAULT_RUNPOD_IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04";

export class AcceleratorError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AcceleratorError";
	}
}

type Body = Record<string, unknown>;

const str = (b: Body, k: string): string | undefined => (typeof b[k] === "string" ? (b[k] as string).trim() : undefined);
const num = (b: Body, k: string): number | undefined => {
	const v = b[k];
	if (v === undefined || v === null || v === "") return undefined;
	const n = typeof v === "number" ? v : Number(v);
	if (!Number.isFinite(n)) throw new AcceleratorError(`${k} must be a number.`);
	return n;
};
const bounded = (n: number | undefined, fallback: number, min: number, max: number, label: string): number => {
	const v = n ?? fallback;
	if (v < min || v > max) throw new AcceleratorError(`${label} must be between ${min} and ${max}.`);
	return Math.round(v);
};
/** One shell-safe word for ssh's host / user (no option injection, no spaces). */
const SAFE_WORD = /^[A-Za-z0-9_.@:%+\-\[\]]+$/;
const oneLine = (v: string, label: string): string => {
	if (/[\n\r\0]/.test(v)) throw new AcceleratorError(`${label} must be one line.`);
	return v;
};

/**
 * Validate a create / update body → an Accelerator. `prev` (an update)
 * supplies the id, kind and any field the body leaves out.
 */
export function parseAccelerator(body: Body, id: string, prev?: Accelerator): Accelerator {
	const merged: Body = { ...(prev ?? {}), ...body };
	const kind = (prev?.kind ?? str(merged, "kind")) as AcceleratorKind | undefined;
	if (!kind || !ACCELERATOR_KINDS.includes(kind)) throw new AcceleratorError(`kind must be one of ${ACCELERATOR_KINDS.join(", ")}.`);
	const name = oneLine(str(merged, "name") ?? "", "name");
	if (!name) throw new AcceleratorError("Give the accelerator a name.");
	const cloud = kind !== "ssh";
	const base = {
		id: prev?.id ?? id,
		name: name.slice(0, 60),
		runTimeoutMin: bounded(num(merged, "runTimeoutMin"), 360, 1, 7 * 24 * 60, "Run time limit"),
		idleStopMin: bounded(num(merged, "idleStopMin"), cloud ? 20 : 0, 0, 7 * 24 * 60, "Idle stop"),
	};
	if (kind === "ssh") {
		const host = str(merged, "host") ?? "";
		if (!host || host.startsWith("-") || !SAFE_WORD.test(host)) throw new AcceleratorError("host must be an ~/.ssh/config alias, hostname or IP.");
		const user = str(merged, "user") || undefined;
		if (user && (user.startsWith("-") || !SAFE_WORD.test(user))) throw new AcceleratorError("user has characters ssh won't take.");
		const port = num(merged, "port");
		if (port !== undefined && (port < 1 || port > 65535)) throw new AcceleratorError("port must be 1–65535.");
		const identityFile = oneLine(str(merged, "identityFile") ?? "", "identity file") || undefined;
		if (identityFile?.startsWith("-")) throw new AcceleratorError("identity file must be a path.");
		const python = oneLine(str(merged, "python") || "python3", "Python command");
		const workdir = oneLine(str(merged, "workdir") || "~/socratech", "work folder");
		const sshOptions = parseSshOptions(merged.sshOptions);
		return {
			...base,
			kind,
			host,
			...(user ? { user } : {}),
			...(port ? { port: Math.round(port) } : {}),
			...(identityFile ? { identityFile } : {}),
			python,
			workdir,
			...(sshOptions.length ? { sshOptions } : {}),
		};
	}
	if (kind === "runpod") {
		const gpuType = oneLine(str(merged, "gpuType") ?? "", "GPU type");
		if (!gpuType) throw new AcceleratorError("Pick a RunPod GPU type.");
		const c = str(merged, "cloud") ?? "SECURE";
		if (c !== "SECURE" && c !== "COMMUNITY") throw new AcceleratorError("cloud must be SECURE or COMMUNITY.");
		const image = oneLine(str(merged, "image") || DEFAULT_RUNPOD_IMAGE, "image");
		return {
			...base,
			kind,
			gpuType,
			gpuCount: bounded(num(merged, "gpuCount"), 1, 1, 8, "GPU count"),
			cloud: c,
			image,
			diskGb: bounded(num(merged, "diskGb"), 40, 10, 2000, "Disk"),
		};
	}
	const gpu = oneLine(str(merged, "gpu") ?? "", "GPU");
	if (gpu && !/^[A-Za-z0-9_\-]+(:\d+)?$/.test(gpu)) throw new AcceleratorError('GPU looks like "A10G", "H100" or "A100-80GB:2".');
	const packages = oneLine(str(merged, "packages") ?? "", "packages");
	const pythonVersion = str(merged, "pythonVersion") || "3.11";
	if (!/^3\.\d{1,2}$/.test(pythonVersion)) throw new AcceleratorError('Python version looks like "3.11".');
	return {
		...base,
		kind,
		gpu,
		packages,
		image: oneLine(str(merged, "image") ?? "", "image"),
		pythonVersion,
		maxLifetimeMin: bounded(num(merged, "maxLifetimeMin"), 240, 5, 24 * 60, "Max lifetime"),
	};
}

/** ssh options that would run a local command — never from a form field. */
const BLOCKED_SSH_OPTIONS = new Set(["proxycommand", "localcommand", "permitlocalcommand", "knownhostscommand", "remotecommand", "match", "include"]);

/** "Key=Value Key2=Value2" (or an array) → validated `-o` options. */
export function parseSshOptions(v: unknown): string[] {
	const items = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/\s+/) : [];
	const out: string[] = [];
	for (const raw of items) {
		const o = raw.trim();
		if (!o) continue;
		const m = /^([A-Za-z]+)=(\S+)$/.exec(o);
		if (!m) throw new AcceleratorError(`ssh option "${o}" should look like Key=Value.`);
		if (BLOCKED_SSH_OPTIONS.has(m[1]!.toLowerCase())) throw new AcceleratorError(`ssh option ${m[1]} is not allowed here — put it in ~/.ssh/config.`);
		out.push(o);
	}
	return out;
}

/** What the notebook header shows: "A10G · Modal". */
export function acceleratorSummary(a: Accelerator): string {
	if (a.kind === "ssh") return `${a.user ? `${a.user}@` : ""}${a.host}${a.port ? `:${a.port}` : ""}`;
	if (a.kind === "runpod") return `${a.gpuCount > 1 ? `${a.gpuCount}× ` : ""}${a.gpuType.replace(/^NVIDIA (GeForce )?/, "")} · RunPod`;
	return `${a.gpu || "CPU"} · Modal`;
}

// ─── The kernel driver (every transport runs this) ─────────────────────────

/**
 * Requests are JSON lines on stdin, read by a thread: `{code, sentinel,
 * lang}` runs a cell, `{interrupt: true}` raises KeyboardInterrupt in the
 * running cell (a real SIGINT, so blocking calls break too). stdin EOF =
 * the app side is gone → the process exits, so a dead ssh / bridge never
 * leaves a remote kernel holding a GPU. User code sees an empty stdin.
 * The first stdout line is `\x1eREADY {python, host, cwd, gpus}`.
 * C++ (`lang: "cpp"`) compiles and runs inside the work folder — on a
 * remote machine that is how C++ cells reach its compiler and GPU.
 */
export const KERNEL_DRIVER = String.raw`
import ast, json, linecache, os, platform, queue, signal, subprocess, sys, tempfile, shutil, threading, traceback
work = os.path.expanduser(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else os.getcwd()
os.makedirs(work, exist_ok=True)
os.chdir(work)
req = os.fdopen(os.dup(0), "r")
_null = os.open(os.devnull, os.O_RDONLY)
os.dup2(_null, 0)
sys.stdin = open(os.devnull)
jobs = queue.Queue()
busy = [False]
def _on_int(sig, frame):
    if busy[0]:
        raise KeyboardInterrupt
signal.signal(signal.SIGINT, _on_int)
def _reader():
    for line in req:
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if msg.get("interrupt"):
            if busy[0]:
                os.kill(os.getpid(), signal.SIGINT)
        else:
            jobs.put(msg)
    os._exit(0)
threading.Thread(target=_reader, daemon=True).start()
def _info():
    d = {"python": sys.version.split()[0], "host": platform.node(), "cwd": work}
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True, timeout=15)
        gpus = [l.strip() for l in r.stdout.splitlines() if l.strip()]
        if gpus:
            d["gpus"] = gpus
    except Exception:
        pass
    return d
sys.stdout.write("\x1eREADY " + json.dumps(_info()) + "\n")
sys.stdout.flush()
def _cpp(code):
    d = tempfile.mkdtemp(prefix="lh-cpp-")
    try:
        src = os.path.join(d, "main.cpp")
        with open(src, "w") as f:
            f.write(code)
        exe = os.path.join(d, "main")
        cxx = os.environ.get("LH_CXX", "g++")
        try:
            c = subprocess.run([cxx, "-std=c++20", "-O1", "-pipe", "-o", exe, src], capture_output=True, text=True)
        except FileNotFoundError:
            print('[could not start the C++ compiler "%s" on this machine]' % cxx)
            return "err"
        if c.returncode != 0:
            sys.stdout.write(c.stdout + c.stderr)
            print("[compile failed]")
            return "err"
        sys.stdout.write(c.stderr)
        r = subprocess.run([exe], cwd=work, capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        sys.stdout.write(r.stderr)
        if r.returncode < 0:
            print("[killed by signal %d]" % -r.returncode)
            return "err"
        if r.returncode != 0:
            print("[exit code %d]" % r.returncode)
            return "err"
        return "ok"
    finally:
        shutil.rmtree(d, ignore_errors=True)
g = {"__name__": "__main__", "__builtins__": __builtins__}
n = 0
while True:
    msg = jobs.get()
    code, sent = msg["code"], msg["sentinel"]
    n += 1
    status = "ok"
    try:
        busy[0] = True
        if msg.get("lang") == "cpp":
            status = _cpp(code)
        else:
            name = "<cell %d>" % n
            linecache.cache[name] = (len(code), None, code.splitlines(True), name)
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
        # The learner's frames only: none of this driver's (its file is "<string>").
        te = traceback.TracebackException(type(e), e, e.__traceback__)
        te.stack = traceback.StackSummary.from_list([f for f in te.stack if f.filename != "<string>"])
        sys.stderr.write("".join(te.format()))
    finally:
        busy[0] = False
    sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__
    sys.stdout.write(sent + ":" + status + "\n"); sys.stdout.flush()
    sys.stderr.write(sent + "\n"); sys.stderr.flush()
`;

/** The marker the driver prints once it is up (and the bridge's progress lines). */
export const KERNEL_READY = "\u001eREADY ";
export const KERNEL_PHASE = "\u001ePHASE ";

/** `python -c` source that runs the driver — base64, so no remote shell ever re-quotes it. */
export function driverBootstrap(): string {
	const b64 = Buffer.from(KERNEL_DRIVER, "utf8").toString("base64");
	return `import base64;exec(base64.b64decode("${b64}").decode())`;
}

/** POSIX single-quote a word for a remote shell. */
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─── SSH ────────────────────────────────────────────────────────────────────

export interface SshTarget {
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	/** Extra `-o` options (RunPod: its own known_hosts). */
	options?: string[];
}

/** Non-interactive, fail-fast ssh args; the user's ~/.ssh/config (keys, ProxyJump) still applies. */
export function sshArgs(t: SshTarget, remoteCommand: string): string[] {
	return [
		"-T",
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=15",
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=3",
		...(t.port ? ["-p", String(t.port)] : []),
		...(t.identityFile ? ["-i", t.identityFile, "-o", "IdentitiesOnly=yes"] : []),
		...(t.options ?? []).flatMap((o) => ["-o", o]),
		t.user ? `${t.user}@${t.host}` : t.host,
		remoteCommand,
	];
}

/** The remote shell command that starts the kernel in `<workdir>/<journal>`. */
export function remoteKernelCommand(python: string, workdir: string, journalId: string): string {
	const dir = `${workdir.replace(/\/+$/, "")}/${journalId.replace(/[^\w-]/g, "_")}`;
	return `${python} -u -c ${shellQuote(driverBootstrap())} ${shellQuote(dir)}`;
}

/** `Host` aliases in an ssh config (no wildcards, no negations) — suggestions in Settings. */
export function sshConfigHosts(config: string): string[] {
	const hosts = new Set<string>();
	for (const line of config.split("\n")) {
		const m = /^\s*Host\s+(.+)$/i.exec(line);
		if (!m) continue;
		for (const h of m[1]!.split(/\s+/)) if (h && !/[*?!]/.test(h)) hosts.add(h);
	}
	return [...hosts];
}

// ─── RunPod (REST v2) ───────────────────────────────────────────────────────

export const RUNPOD_API = "https://api.runpod.io/v2";

/** POST /v2/pods body: our key in PUBLIC_KEY (and SSH_PUBLIC_KEY, which the docs also name), 22/tcp exposed. */
export function runpodCreateBody(a: RunPodAccelerator, journalId: string, publicKey: string): Record<string, unknown> {
	return {
		name: `socratech-${journalId}`.slice(0, 60),
		image: a.image,
		gpu: { id: a.gpuType, count: a.gpuCount },
		cloud: a.cloud,
		disk: a.diskGb,
		ports: ["22/tcp"],
		env: { PUBLIC_KEY: publicKey, SSH_PUBLIC_KEY: publicKey },
	};
}

export type RunPodPodView = { status: string; ssh?: { host: string; port: number } };

/** A GET /v2/pods/{id} body → status and, once it has one, the direct SSH endpoint. */
export function runpodPodView(pod: unknown): RunPodPodView {
	const p = (pod ?? {}) as {
		status?: string;
		ssh?: { direct?: { host?: string; port?: number } | null } | null;
		runtime?: { ports?: { private?: number; public?: number; ip?: string; type?: string }[] } | null;
	};
	const status = String(p.status ?? "UNKNOWN");
	const direct = p.ssh?.direct;
	if (direct?.host && direct.port) return { status, ssh: { host: direct.host, port: direct.port } };
	const port22 = p.runtime?.ports?.find((x) => x.private === 22 && (x.type ?? "tcp") === "tcp" && x.ip && x.public);
	if (port22) return { status, ssh: { host: port22.ip!, port: port22.public! } };
	return { status };
}

// ─── Modal bridge ───────────────────────────────────────────────────────────

/**
 * Runs locally under the app's Modal venv: starts a Sandbox, execs the
 * driver in it and relays stdio. Its OWN logs go to a file (argv[2]) —
 * kernel stderr carries the run sentinels, so nothing else may write
 * there. SIGTERM / stdin EOF / the process ending → the sandbox is
 * terminated. `{"check": true}` only checks the token.
 */
export const MODAL_BRIDGE = String.raw`
import base64, json, os, signal, sys, threading
cfg = json.loads(base64.b64decode(sys.argv[1]).decode())
out = os.fdopen(os.dup(1), "w")
err = os.fdopen(os.dup(2), "w")
log = open(sys.argv[2], "a")
os.dup2(log.fileno(), 1)
os.dup2(log.fileno(), 2)
def phase(t):
    out.write("\x1ePHASE " + t + "\n"); out.flush()
done = threading.Event()
def _stop(*_):
    done.set()
signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT, _stop)
def fail(e):
    # Before the kernel starts, stderr is ours: the app shows this line as the reason.
    err.write("Modal: %s: %s\n" % (type(e).__name__, str(e).strip().splitlines()[-1] if str(e).strip() else "")); err.flush()
    log.write("fatal: %r\n" % e); log.flush()
    os._exit(1)
try:
    import modal
    app = modal.App.lookup("socratech-notebooks", create_if_missing=True)
    if cfg.get("check"):
        out.write("ok\n"); out.flush(); os._exit(0)
    image = modal.Image.from_registry(cfg["image"], add_python=cfg["pythonVersion"]) if cfg.get("image") else modal.Image.debian_slim(python_version=cfg["pythonVersion"])
    if cfg.get("packages"):
        image = image.pip_install(*cfg["packages"])
    phase("starting a Modal sandbox" + (" with " + cfg["gpu"] if cfg.get("gpu") else "") + " (building the image the first time can take minutes)")
    sb = modal.Sandbox.create(app=app, image=image, gpu=cfg.get("gpu") or None, timeout=cfg["timeout"], idle_timeout=cfg.get("idleTimeout") or None, tags={"socratech": cfg["name"]})
except Exception as e:
    fail(e)
try:
    phase("sandbox up — starting Python")
    p = sb.exec("python", "-u", "-c", cfg["boot"], "/root/socratech", text=True)
    def _pump(src, dst):
        try:
            for chunk in src:
                dst.write(chunk); dst.flush()
        except Exception as e:
            log.write("pump: %r\n" % e); log.flush()
        done.set()
    def _feed():
        try:
            for line in sys.stdin:
                p.stdin.write(line); p.stdin.drain()
        except Exception as e:
            log.write("feed: %r\n" % e); log.flush()
        done.set()
    threading.Thread(target=_pump, args=(p.stdout, out), daemon=True).start()
    threading.Thread(target=_pump, args=(p.stderr, err), daemon=True).start()
    threading.Thread(target=_feed, daemon=True).start()
    while not done.wait(1):
        pass
finally:
    try:
        sb.terminate()
    except Exception as e:
        log.write("terminate: %r\n" % e); log.flush()
    os._exit(0)
`;

/** The bridge's argv[1]: base64 JSON. */
export function modalBridgeConfig(a: ModalAccelerator, journalId: string, opts: { check?: boolean } = {}): string {
	const cfg = opts.check
		? { check: true }
		: {
				gpu: a.gpu,
				packages: a.packages.split(/\s+/).filter(Boolean),
				image: a.image,
				pythonVersion: a.pythonVersion,
				timeout: a.maxLifetimeMin * 60,
				idleTimeout: a.idleStopMin > 0 ? a.idleStopMin * 60 : null,
				name: journalId,
				boot: driverBootstrap(),
			};
	return Buffer.from(JSON.stringify(cfg), "utf8").toString("base64");
}
