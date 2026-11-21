/**
 * Accelerators (owner, 2026-11-21): validation, the ssh / remote-command
 * shapes (run for real through `sh`, so the quoting is proven), RunPod's
 * pod lifecycle against a stubbed API (ledger first, terminate on failure,
 * orphans reconciled), the keys file, and notebooks switching machines.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-accel-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth", "auth.json");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const core = await import("../src/core/accelerators.ts");
const server = await import("../src/server/accelerators.ts");
const { createJournal, patchJournalMeta, requireJournal } = await import("../src/server/journals.ts");
const { stopAllKernels } = await import("../src/server/code-runner.ts");
after(() => stopAllKernels());

const hasPython = (() => {
	try {
		return spawn("python3", ["--version"]).pid !== undefined;
	} catch {
		return false;
	}
})();

describe("parseAccelerator", () => {
	it("fills defaults per kind: SSH never idles out, cloud stops after 20 min", () => {
		const s = core.parseAccelerator({ kind: "ssh", name: "lab", host: "gpu-box" }, "a1");
		assert.deepEqual([s.kind, s.idleStopMin, s.runTimeoutMin, (s as { python: string }).python, (s as { workdir: string }).workdir], ["ssh", 0, 360, "python3", "~/socratech"]);
		const r = core.parseAccelerator({ kind: "runpod", name: "4090", gpuType: "NVIDIA GeForce RTX 4090" }, "a2");
		assert.deepEqual([r.idleStopMin, (r as { cloud: string }).cloud, (r as { image: string }).image], [20, "SECURE", core.DEFAULT_RUNPOD_IMAGE]);
		const m = core.parseAccelerator({ kind: "modal", name: "t4", gpu: "A100-80GB:2" }, "a3");
		assert.equal((m as { gpu: string }).gpu, "A100-80GB:2");
	});
	it("refuses ssh option injection and command-running options", () => {
		assert.throws(() => core.parseAccelerator({ kind: "ssh", name: "x", host: "-oProxyCommand=evil" }, "a"), /host/);
		assert.throws(() => core.parseAccelerator({ kind: "ssh", name: "x", host: "a b" }, "a"), /host/);
		assert.throws(() => core.parseAccelerator({ kind: "ssh", name: "x", host: "h", sshOptions: "ProxyCommand=nc" }, "a"), /not allowed/);
		assert.throws(() => core.parseAccelerator({ kind: "ssh", name: "x", host: "h", python: "python3\nrm -rf ~" }, "a"), /one line/);
		const ok = core.parseAccelerator({ kind: "ssh", name: "x", host: "h", sshOptions: "ProxyJump=bastion UserKnownHostsFile=/tmp/kh" }, "a");
		assert.deepEqual((ok as { sshOptions: string[] }).sshOptions, ["ProxyJump=bastion", "UserKnownHostsFile=/tmp/kh"]);
	});
	it("an update keeps the id and kind", () => {
		const prev = core.parseAccelerator({ kind: "ssh", name: "lab", host: "gpu-box" }, "a1");
		const next = core.parseAccelerator({ kind: "modal", name: "renamed" }, "zzz", prev);
		assert.deepEqual([next.id, next.kind, next.name], ["a1", "ssh", "renamed"]);
	});
});

describe("ssh shapes", () => {
	it("builds non-interactive args with the target last but one", () => {
		const args = core.sshArgs({ host: "h", user: "u", port: 2222, identityFile: "/k", options: ["StrictHostKeyChecking=accept-new"] }, "CMD");
		assert.deepEqual(args.slice(-2), ["u@h", "CMD"]);
		for (const want of ["-T", "BatchMode=yes", "IdentitiesOnly=yes", "StrictHostKeyChecking=accept-new"]) assert.ok(args.includes(want), want);
		assert.deepEqual(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2), ["-p", "2222"]);
	});
	it("lists plain Host aliases from an ssh config", () => {
		assert.deepEqual(core.sshConfigHosts("Host *\n  User x\nHost gpu lab-a !bad\nHost web?\n  host  bastion\n"), ["gpu", "lab-a", "bastion"]);
	});
	it("the remote command survives a real shell with a hostile folder name", { skip: !hasPython }, async () => {
		const dir = path.join(TMP, "it's a $HOME `dir`");
		const cmd = core.remoteKernelCommand("python3", dir, "jrnl/../x");
		const child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
		const done = new Promise<void>((resolve) => child.on("close", () => resolve()));
		child.stdin.write(`${JSON.stringify({ code: "import os\nprint(os.getcwd())", sentinel: "SENT", lang: "python" })}\n`);
		await new Promise<void>((resolve) => {
			const t = setInterval(() => {
				if (out.includes("SENT:")) {
					clearInterval(t);
					resolve();
				}
			}, 20);
		});
		child.stdin.end(); // EOF → the driver exits on its own
		await done;
		assert.match(out, /^\u001eREADY \{/);
		// The journal id is sanitised to one folder name — no "..", no "/".
		assert.ok(out.includes(path.join(dir, "jrnl____x")), out);
		assert.ok(fs.existsSync(path.join(dir, "jrnl____x")));
	});
});

describe("RunPod", () => {
	it("reads the direct SSH endpoint from ssh.direct or runtime.ports", () => {
		assert.deepEqual(core.runpodPodView({ status: "RUNNING", ssh: { direct: { host: "1.2.3.4", port: 40022 } } }), { status: "RUNNING", ssh: { host: "1.2.3.4", port: 40022 } });
		assert.deepEqual(core.runpodPodView({ status: "RUNNING", ssh: { direct: null }, runtime: { ports: [{ private: 8888, public: 1, ip: "x" }, { private: 22, public: 31022, type: "tcp", ip: "5.6.7.8" }] } }), { status: "RUNNING", ssh: { host: "5.6.7.8", port: 31022 } });
		assert.deepEqual(core.runpodPodView({ status: "PROVISIONING", runtime: null }), { status: "PROVISIONING" });
	});
	it("the create body exposes 22/tcp and carries our public key", () => {
		const a = core.parseAccelerator({ kind: "runpod", name: "x", gpuType: "NVIDIA A40", gpuCount: 2 }, "a") as never;
		const body = core.runpodCreateBody(a, "jrnl_1", "ssh-ed25519 AAAA test");
		assert.deepEqual(body.gpu, { id: "NVIDIA A40", count: 2 });
		assert.deepEqual(body.ports, ["22/tcp"]);
		assert.equal((body.env as Record<string, string>).PUBLIC_KEY, "ssh-ed25519 AAAA test");
	});
	it("records the pod before it boots, and terminates it when the connect is abandoned", async () => {
		server.setAcceleratorKeys({ runpodApiKey: "rp_test" });
		const calls: string[] = [];
		const realFetch = globalThis.fetch;
		const ledger = path.join(TMP, "accelerators", "runpod-pods.json");
		let ledgerAtFirstPoll: unknown = null;
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push(`${method} ${String(url).replace(core.RUNPOD_API, "")}`);
			assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer rp_test");
			if (method === "POST") return new Response(JSON.stringify({ id: "pod123", status: "PROVISIONING" }), { status: 201 });
			if (method === "DELETE") return new Response(null, { status: 204 });
			ledgerAtFirstPoll ??= JSON.parse(fs.readFileSync(ledger, "utf8"));
			return new Response(JSON.stringify({ id: "pod123", status: "PROVISIONING" }), { status: 200 });
		}) as typeof fetch;
		try {
			const a = server.createAccelerator({ kind: "runpod", name: "rp", gpuType: "NVIDIA A40" });
			const abort = new AbortController();
			const phases: string[] = [];
			const opening = server.openTransport(a, "jrnl_rp", (p) => phases.push(p), abort.signal);
			setTimeout(() => abort.abort(), 200);
			await assert.rejects(opening, /Cancelled/);
			assert.deepEqual((ledgerAtFirstPoll as { podId: string }[]).map((p) => p.podId), ["pod123"]);
			assert.deepEqual(calls.filter((c) => !c.startsWith("GET")), ["POST /pods", "DELETE /pods/pod123"]);
			assert.deepEqual(server.runpodLedger(), []);
			assert.ok(phases.some((p) => p.includes("provisioning")), phases.join(" | "));
		} finally {
			globalThis.fetch = realFetch;
		}
	});
	it("terminates pods a crash left behind, once per process", async () => {
		fs.writeFileSync(path.join(TMP, "accelerators", "runpod-pods.json"), JSON.stringify([{ podId: "orphan1", journalId: "j", acceleratorId: "a", createdAt: "x" }]));
		delete (globalThis as { __lhRunpodReconciled?: unknown }).__lhRunpodReconciled;
		const deleted: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			if (init?.method === "DELETE") deleted.push(String(url).split("/").at(-1)!);
			return new Response(null, { status: 204 });
		}) as typeof fetch;
		try {
			await server.reconcileRunPods();
			await server.reconcileRunPods();
			assert.deepEqual(deleted, ["orphan1"]);
			assert.deepEqual(server.runpodLedger(), []);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("RunPod orphans at boot", () => {
	it("opening any notebook's kernel status terminates a pod left from a crash", async () => {
		server.setAcceleratorKeys({ runpodApiKey: "rp_boot" });
		fs.writeFileSync(path.join(TMP, "accelerators", "runpod-pods.json"), JSON.stringify([{ podId: "crashpod", journalId: "j", acceleratorId: "a", createdAt: "x" }]));
		fs.writeFileSync(path.join(TMP, "accelerators", "known_hosts-crashpod"), "x");
		delete (globalThis as { __lhRunpodReconciled?: unknown }).__lhRunpodReconciled;
		const deleted: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			if (init?.method === "DELETE") deleted.push(String(url).split("/").at(-1)!);
			return new Response(null, { status: 204 });
		}) as typeof fetch;
		try {
			const { journalKernelStatus } = await import("../src/server/journals.ts");
			const j = createJournal({ title: "Boot" });
			assert.equal(journalKernelStatus(j.id).state, "off");
			await server.reconcileRunPods(); // the same memoised run the status call started
			assert.deepEqual(deleted, ["crashpod"]);
			assert.deepEqual(server.runpodLedger(), []);
			assert.equal(fs.existsSync(path.join(TMP, "accelerators", "known_hosts-crashpod")), false);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("keys and the list", () => {
	it("keys are stored 0600 and only ever reported as booleans", () => {
		const status = server.setAcceleratorKeys({ modalTokenId: "ak-1", modalTokenSecret: "as-2" });
		assert.deepEqual(status, { runpod: true, modal: true });
		const file = path.join(TMP, "auth", "accelerator-keys.json");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		const overview = JSON.stringify(server.acceleratorOverview());
		for (const secret of ["ak-1", "as-2", "rp_test"]) assert.ok(!overview.includes(secret), secret);
		assert.deepEqual(server.setAcceleratorKeys({ runpodApiKey: null }), { runpod: false, modal: true });
		assert.throws(() => server.setAcceleratorKeys({ runpodApiKey: "two words" }), /spaces/);
	});
	it("a notebook points at an accelerator, refuses an unknown one, and clears back to this machine", () => {
		const a = server.createAccelerator({ kind: "ssh", name: "box", host: "box" });
		const j = createJournal({ title: "On a box" });
		assert.throws(() => patchJournalMeta(j.id, { accelerator: "acc_nope" }), /No accelerator/);
		assert.equal(patchJournalMeta(j.id, { accelerator: a.id }).accelerator, a.id);
		assert.equal(requireJournal(j.id).accelerator, a.id);
		assert.equal(patchJournalMeta(j.id, { accelerator: null }).accelerator, undefined);
		assert.ok(server.deleteAccelerator(a.id));
		assert.equal(server.getAccelerator(a.id), null);
	});
});
