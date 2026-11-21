"use client";

/**
 * Settings → Accelerators (owner, 2026-11-21): somewhere other than this
 * machine for notebooks to run — your own SSH servers, or your own RunPod /
 * Modal account (bring your own key). A notebook picks one in its header.
 * Keys are stored 0600 beside auth.json and never come back to the page.
 */

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, LoaderCircleIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import {
	ACCELERATOR_KIND_LABEL,
	DEFAULT_RUNPOD_IMAGE,
	MODAL_GPU_SUGGESTIONS,
	RUNPOD_GPU_SUGGESTIONS,
	acceleratorSummary,
	type Accelerator,
	type AcceleratorKind,
} from "@/src/core";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./controls";

type Overview = {
	accelerators: Accelerator[];
	keys: { runpod: boolean; modal: boolean };
	modalInstalled: boolean;
	sshHosts: string[];
	pods: { podId: string; journalId: string; acceleratorId: string; createdAt: string }[];
};

type Draft = Record<string, string>;

async function json<T>(url: string, method = "GET", body?: unknown): Promise<T> {
	const res = await fetch(url, { method, cache: "no-store", ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
	const data = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
	return data;
}

const input = "lh-input w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none";
const button = "flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-40";

/** Each kind's form: [field, label, placeholder, hint?]. */
const FIELDS: Record<AcceleratorKind, [string, string, string, string?][]> = {
	ssh: [
		["host", "Host", "an ~/.ssh/config alias, hostname or IP", "Aliases from ~/.ssh/config bring their keys, user and ProxyJump with them."],
		["user", "User", "optional"],
		["port", "Port", "22"],
		["identityFile", "Key file", "optional, e.g. ~/.ssh/id_ed25519"],
		["python", "Python command", "python3", "e.g. ~/venv/bin/python or conda run -n ml python"],
		["workdir", "Work folder", "~/socratech", "Each notebook gets its own folder inside it."],
		["sshOptions", "Extra ssh options", "optional, e.g. ProxyJump=bastion", "Key=Value, space separated."],
	],
	runpod: [
		["gpuType", "GPU", "NVIDIA GeForce RTX 4090"],
		["gpuCount", "GPUs", "1"],
		["cloud", "Cloud", "SECURE"],
		["image", "Image", DEFAULT_RUNPOD_IMAGE, "Must start sshd from PUBLIC_KEY — RunPod's official images do."],
		["diskGb", "Disk (GB)", "40"],
	],
	modal: [
		["gpu", "GPU", "empty = CPU only", "T4, L4, A10G, L40S, A100, A100-80GB, H100 — add :2 for two."],
		["packages", "pip packages", "e.g. torch numpy matplotlib"],
		["image", "Base image", "optional, e.g. nvidia/cuda:12.4.1-devel-ubuntu22.04"],
		["pythonVersion", "Python", "3.11"],
		["maxLifetimeMin", "Max lifetime (min)", "240"],
	],
};

const COMMON: [string, string, string, string?][] = [
	["runTimeoutMin", "Cell time limit (min)", "360"],
	["idleStopMin", "Stop after idle (min)", "", "0 = never. Cloud machines bill while up — default 20."],
];

function toDraft(a: Accelerator): Draft {
	const d: Draft = {};
	for (const [k, v] of Object.entries(a)) d[k] = Array.isArray(v) ? v.join(" ") : v === undefined ? "" : String(v);
	return d;
}

export function AcceleratorsSection() {
	const [view, setView] = useState<Overview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<{ id?: string; kind: AcceleratorKind; draft: Draft } | null>(null);
	const [tests, setTests] = useState<Record<string, { ok: boolean; detail: string } | "running">>({});
	const [keys, setKeys] = useState<Draft>({});
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setView(await json<Overview>("/api/accelerators"));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);
	useEffect(() => void load(), [load]);

	const act = async (key: string, fn: () => Promise<void>) => {
		setBusy(key);
		setError(null);
		try {
			await fn();
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	if (!view) return error ? <p className="text-xs text-destructive">{error}</p> : <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />;

	const save = () =>
		act("save", async () => {
			if (!editing) return;
			const body: Record<string, unknown> = { kind: editing.kind };
			for (const [k, v] of Object.entries(editing.draft)) if (k !== "id" && k !== "kind") body[k] = v;
			if (editing.id) await json(`/api/accelerators/${editing.id}`, "PUT", body);
			else await json("/api/accelerators", "POST", body);
			setEditing(null);
		});

	const suggestions = (field: string, kind: AcceleratorKind): string[] =>
		field === "host" ? view.sshHosts : field === "gpuType" ? RUNPOD_GPU_SUGGESTIONS : field === "gpu" && kind === "modal" ? MODAL_GPU_SUGGESTIONS : [];

	return (
		<div data-testid="accelerators-settings">
			<SettingsGroup label="Your accelerators">
				<p className="text-xs text-muted-foreground">
					Run a notebook&apos;s code somewhere else: your own server over SSH, or a GPU on your own RunPod or Modal account. Pick one in a notebook&apos;s header; Python variables
					live there until you disconnect. Files on this machine are not copied over.
				</p>
				{view.accelerators.length === 0 && !editing && <p className="text-xs italic text-muted-foreground">None yet.</p>}
				<ul className="flex flex-col gap-1.5">
					{view.accelerators.map((a) => {
						const t = tests[a.id];
						return (
							<li key={a.id} className="rounded-md border border-border px-2.5 py-1.5 text-xs" data-testid="accelerator-row">
								<div className="flex items-center gap-2">
									<span className="font-medium">{a.name}</span>
									<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{ACCELERATOR_KIND_LABEL[a.kind]}</span>
									<span className="min-w-0 truncate text-muted-foreground">{acceleratorSummary(a)}</span>
									<span className="flex-1" />
									<button
										type="button"
										className={button}
										disabled={t === "running"}
										onClick={() => {
											setTests((m) => ({ ...m, [a.id]: "running" }));
											void json<{ ok: boolean; detail: string }>(`/api/accelerators/${a.id}`, "POST", { action: "test" })
												.then((r) => setTests((m) => ({ ...m, [a.id]: r })))
												.catch((err: unknown) => setTests((m) => ({ ...m, [a.id]: { ok: false, detail: err instanceof Error ? err.message : String(err) } })));
										}}
										title={a.kind === "ssh" ? "Start Python on the server and stop it again" : "Check the key (never starts a paid machine)"}
									>
										{t === "running" ? <LoaderCircleIcon className="size-3 animate-spin" /> : null} Test
									</button>
									<button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={`Edit ${a.name}`} onClick={() => setEditing({ id: a.id, kind: a.kind, draft: toDraft(a) })}>
										<PencilIcon className="size-3.5" />
									</button>
									<button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive" aria-label={`Delete ${a.name}`} onClick={() => void act(`del-${a.id}`, async () => void (await json(`/api/accelerators/${a.id}`, "DELETE")))}>
										<Trash2Icon className="size-3.5" />
									</button>
								</div>
								{t && t !== "running" && (
									<p className={cn("mt-1 flex items-start gap-1", t.ok ? "text-success" : "text-destructive")} data-testid="accelerator-test-result">
										{t.ok ? <CheckIcon className="mt-px size-3 shrink-0" /> : <XIcon className="mt-px size-3 shrink-0" />}
										<span className="break-words">{t.detail}</span>
									</p>
								)}
							</li>
						);
					})}
				</ul>

				{editing ? (
					<div className="flex flex-col gap-2 rounded-md border border-primary/40 p-3" data-testid="accelerator-form">
						<div className="flex items-center gap-1">
							{(Object.keys(ACCELERATOR_KIND_LABEL) as AcceleratorKind[]).map((k) => (
								<button
									key={k}
									type="button"
									disabled={Boolean(editing.id) && k !== editing.kind}
									onClick={() => setEditing({ ...editing, kind: k })}
									className={cn("rounded-md px-2.5 py-1 text-xs", k === editing.kind ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-accent disabled:opacity-30")}
								>
									{ACCELERATOR_KIND_LABEL[k]}
								</button>
							))}
						</div>
						{editing.kind !== "ssh" && !view.keys[editing.kind] && <p className="text-xs text-warning">Add your {ACCELERATOR_KIND_LABEL[editing.kind]} key below first.</p>}
						<div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
							{[["name", "Name", editing.kind === "ssh" ? "e.g. lab GPU box" : "e.g. 4090 for training"] as [string, string, string, string?], ...FIELDS[editing.kind], ...COMMON].map(([k, label, ph, hint]) => {
								const list = suggestions(k, editing.kind);
								return (
									<label key={k} className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
										{label}
										{k === "cloud" ? (
											<select className={input} value={editing.draft[k] || "SECURE"} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, [k]: e.target.value } })}>
												<option value="SECURE">Secure cloud</option>
												<option value="COMMUNITY">Community cloud (cheaper)</option>
											</select>
										) : (
											<input
												className={input}
												value={editing.draft[k] ?? ""}
												placeholder={k === "idleStopMin" ? (editing.kind === "ssh" ? "0" : "20") : ph}
												list={list.length ? `acc-${k}` : undefined}
												onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, [k]: e.target.value } })}
												data-testid={`accelerator-field-${k}`}
											/>
										)}
										{list.length > 0 && (
											<datalist id={`acc-${k}`}>
												{list.map((v) => (
													<option key={v} value={v} />
												))}
											</datalist>
										)}
										{hint && <span className="text-[10px] text-muted-foreground/80">{hint}</span>}
									</label>
								);
							})}
						</div>
						<div className="flex items-center gap-2">
							<button type="button" className={button} disabled={busy === "save"} onClick={() => void save()} data-testid="accelerator-save">
								{busy === "save" && <LoaderCircleIcon className="size-3 animate-spin" />}
								{editing.id ? "Save" : "Add"}
							</button>
							<button type="button" className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setEditing(null)}>
								Cancel
							</button>
						</div>
					</div>
				) : (
					<button type="button" className={cn(button, "self-start")} onClick={() => setEditing({ kind: "ssh", draft: {} })} data-testid="accelerator-add">
						<PlusIcon className="size-3" /> Add accelerator
					</button>
				)}
			</SettingsGroup>

			<SettingsGroup label="Keys (bring your own)">
				<p className="text-xs text-muted-foreground">Stored only on this machine (beside auth.json, owner-only). They never come back to this page.</p>
				<div className="flex flex-col gap-2 text-xs">
					<div className="flex items-center gap-2">
						<span className="w-28 shrink-0">RunPod API key</span>
						<input className={input} type="password" placeholder={view.keys.runpod ? "saved — paste to replace" : "rpa_…"} value={keys.runpodApiKey ?? ""} onChange={(e) => setKeys({ ...keys, runpodApiKey: e.target.value })} aria-label="RunPod API key" />
						{view.keys.runpod && (
							<button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => void act("rp-clear", async () => void (await json("/api/accelerators/keys", "PUT", { runpodApiKey: null })))}>
								clear
							</button>
						)}
					</div>
					<div className="flex items-center gap-2">
						<span className="w-28 shrink-0">Modal token</span>
						<input className={input} placeholder={view.keys.modal ? "saved — paste to replace" : "ak-… (token id)"} value={keys.modalTokenId ?? ""} onChange={(e) => setKeys({ ...keys, modalTokenId: e.target.value })} aria-label="Modal token id" />
						<input className={input} type="password" placeholder="as-… (token secret)" value={keys.modalTokenSecret ?? ""} onChange={(e) => setKeys({ ...keys, modalTokenSecret: e.target.value })} aria-label="Modal token secret" />
						{view.keys.modal && (
							<button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => void act("m-clear", async () => void (await json("/api/accelerators/keys", "PUT", { modalTokenId: null, modalTokenSecret: null })))}>
								clear
							</button>
						)}
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							className={button}
							disabled={!Object.values(keys).some((v) => v.trim())}
							onClick={() =>
								void act("keys", async () => {
									await json("/api/accelerators/keys", "PUT", keys);
									setKeys({});
								})
							}
						>
							Save keys
						</button>
						<span className="min-w-0 text-[11px] text-muted-foreground">
							RunPod: Settings → API Keys on runpod.io. Modal: <span className="font-mono">modal token new</span>, or modal.com → Settings → API Tokens.
						</span>
					</div>
					<div className="flex items-center gap-2">
						<span className="w-28 shrink-0">Modal SDK</span>
						{view.modalInstalled ? <span className="flex items-center gap-1 text-success"><CheckIcon className="size-3" /> installed</span> : <span className="text-muted-foreground">not installed</span>}
						<button type="button" className={button} disabled={busy === "modal"} onClick={() => void act("modal", async () => void (await json("/api/accelerators/modal", "POST")))}>
							{busy === "modal" && <LoaderCircleIcon className="size-3 animate-spin" />}
							{view.modalInstalled ? "Update" : "Install"}
						</button>
						<span className="min-w-0 text-[11px] text-muted-foreground">Into the app&apos;s own Python environment (~100 MB, one time).</span>
					</div>
				</div>
			</SettingsGroup>

			{view.pods.length > 0 && (
				<SettingsGroup label="RunPod pods the app is holding">
					<ul className="flex flex-col gap-1 text-xs">
						{view.pods.map((p) => (
							<li key={p.podId} className="flex items-center gap-2">
								<span className="font-mono">{p.podId}</span>
								<span className="text-muted-foreground">since {new Date(p.createdAt).toLocaleString()}</span>
								<button type="button" className={button} disabled={busy === p.podId} onClick={() => void act(p.podId, async () => void (await json(`/api/accelerators/pods/${encodeURIComponent(p.podId)}`, "DELETE")))}>
									Terminate
								</button>
							</li>
						))}
					</ul>
				</SettingsGroup>
			)}
			{error && <p className="mt-3 text-xs text-destructive">{error}</p>}
		</div>
	);
}
