"use client";

/**
 * Settings → Second brain (docs/brain-store.md): index Obsidian vaults into
 * the local brain store, import/export `.brain.jsonl` (or mem0 /
 * supermemory JSON), test retrieval, review memories consolidation wrote.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrainHit, BrainRecord, BrainStatus } from "@/src/core";
import { CommitInput, SettingsGroup, SettingsRow, Toggle } from "./controls";

const btn = "rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50";

async function json<T>(res: Response): Promise<T> {
	const body = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
	return body;
}

export function BrainSection() {
	const [status, setStatus] = useState<BrainStatus | null>(null);
	const [memories, setMemories] = useState<BrainRecord[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<BrainHit[] | null>(null);
	const [withChunks, setWithChunks] = useState(true);
	const file = useRef<HTMLInputElement>(null);

	const read = useCallback(async () => {
		try {
			const [s, m] = await Promise.all([fetch("/api/brain", { cache: "no-store" }).then(json<BrainStatus>), fetch("/api/brain/memories", { cache: "no-store" }).then(json<{ memories: BrainRecord[] }>)]);
			setStatus(s);
			setMemories(m.memories);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);
	useEffect(() => {
		void read();
	}, [read]);
	// Poll while indexing / importing.
	useEffect(() => {
		if (!status?.indexing && !status?.progress) return;
		const t = setInterval(() => void read(), 1000);
		return () => clearInterval(t);
	}, [status?.indexing, status?.progress, read]);

	const run = async (fn: () => Promise<string | void>) => {
		setError(null);
		setNotice(null);
		try {
			const msg = await fn();
			if (msg) setNotice(msg);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
		await read();
	};

	const index = (dir?: string) =>
		run(async () => {
			await fetch("/api/brain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "index", ...(dir ? { dir } : {}) }) }).then(json);
			return "Indexing… the first run downloads the local embedding model (~35 MB).";
		});

	const importFile = (f: File) =>
		run(async () => {
			const r = await fetch(`/api/brain/import?name=${encodeURIComponent(f.name)}`, { method: "POST", body: await f.text() }).then(json<{ added: number; skipped: number; format: string }>);
			return `Imported ${r.added} record${r.added === 1 ? "" : "s"} (${r.format === "brain/1" ? ".brain bundle" : "mem0 / supermemory"}), ${r.skipped} already present.`;
		});

	const search = () =>
		run(async () => {
			const r = await fetch(`/api/brain/search?q=${encodeURIComponent(query)}&k=8`).then(json<{ hits: BrainHit[] }>);
			setHits(r.hits);
		});

	const busy = !!status?.indexing || !!status?.progress;

	return (
		<>
			<SettingsGroup label="Store" testid="brain-store">
				<SettingsRow label="Contents" hint={status?.embedding ? `Embeddings: ${status.embedding.model} (local, ${status.embedding.dims}d)` : "Nothing indexed yet."}>
					<span className="text-xs text-muted-foreground" data-testid="brain-counts">
						{status ? `${status.notes} notes · ${status.chunks} chunks · ${status.memories} memories` : "…"}
					</span>
				</SettingsRow>
				{status?.progress && (
					<SettingsRow label="Embedding">
						<span className="text-xs text-muted-foreground">
							{status.progress.done} / {status.progress.total}
						</span>
					</SettingsRow>
				)}
				{status?.lastConsolidated && (
					<SettingsRow label="Last consolidation" hint="Automatic: 10 min after a session goes quiet, 2 min after a journal edit.">
						<span className="text-xs text-muted-foreground">{new Date(status.lastConsolidated).toLocaleString()}</span>
					</SettingsRow>
				)}
			</SettingsGroup>

			<SettingsGroup label="Vaults" testid="brain-vaults">
				{status?.vaults.map((v) => (
					<SettingsRow key={v.name} label={v.name} hint={v.dir}>
						<div className="flex items-center gap-2">
							<span className="text-xs text-muted-foreground">{v.chunks} chunks</span>
							<button type="button" className={btn} disabled={busy} onClick={() => void index(v.dir)}>
								Re-index
							</button>
							<button type="button" className={btn} disabled={busy} onClick={() => void run(async () => void (await fetch("/api/brain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "remove", vault: v.name }) }).then(json)))}>
								Remove
							</button>
						</div>
					</SettingsRow>
				))}
				{!status?.vaults.some((v) => v.name === "notes") && (
					<SettingsRow label="This app's notes" hint="Re-indexes automatically as you write.">
						<button type="button" className={btn} disabled={busy} onClick={() => void index()}>
							Index notes
						</button>
					</SettingsRow>
				)}
				<SettingsRow label="Import Obsidian vault" hint="Absolute folder path. Wikilinks, tags and headings are kept; .obsidian/ is skipped.">
					<CommitInput value="" placeholder="/home/me/Obsidian/MyVault" ariaLabel="Obsidian vault path" testid="brain-vault-path" onCommit={(v) => v.trim() && void index(v.trim())} />
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup label="Transfer" testid="brain-transfer">
				<SettingsRow label="Export .brain.jsonl" hint="Portable brain/1 bundle: manifest + one record per line (mem0-shaped), with vectors.">
					<div className="flex items-center gap-2">
						<Toggle label="Include note chunks" checked={withChunks} onChange={setWithChunks} />
						<a className={btn} href={`/api/brain/export${withChunks ? "" : "?chunks=0"}`} download>
							Export
						</a>
					</div>
				</SettingsRow>
				<SettingsRow label="Import" hint=".brain.jsonl bundle, or a mem0 / supermemory JSON export.">
					<input
						ref={file}
						type="file"
						accept=".jsonl,.json,application/json"
						className="hidden"
						onChange={(e) => {
							const f = e.target.files?.[0];
							e.target.value = "";
							if (f) void importFile(f);
						}}
					/>
					<button type="button" className={btn} disabled={busy} onClick={() => file.current?.click()}>
						Choose file…
					</button>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup label="Try a search" testid="brain-search">
				<div className="flex gap-2 px-3 py-2">
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && void search()}
						placeholder="What do I know about…"
						aria-label="Search the brain"
						className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-sm"
					/>
					<button type="button" className={btn} onClick={() => void search()} disabled={!query.trim()}>
						Search
					</button>
				</div>
				{hits && (
					<ul className="space-y-2 px-3 pb-3 text-xs">
						{hits.length === 0 && <li className="text-muted-foreground">No matches.</li>}
						{hits.map((h) => (
							<li key={h.record.id} className="rounded border border-border p-2">
								<div className="mb-1 text-muted-foreground">
									{h.record.type === "memory" ? `memory · ${h.record.source.kind}` : `${h.record.source.vault ?? "notes"}/${h.record.source.ref}${h.record.source.heading ? ` › ${h.record.source.heading}` : ""}`}
									{h.via === "link" && " · via link"}
								</div>
								<div className="line-clamp-3 whitespace-pre-wrap">{h.record.text}</div>
							</li>
						))}
					</ul>
				)}
			</SettingsGroup>

			<SettingsGroup label={`Memories (${memories.length})`} testid="brain-memories">
				{memories.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">None yet: they come from imports and from consolidating sessions and journals.</p>}
				<ul className="max-h-72 overflow-y-auto">
					{memories.map((m) => (
						<li key={m.id} className="flex items-start gap-2 border-b border-border px-3 py-1.5 text-xs last:border-0">
							<span className="flex-1">{m.text}</span>
							<span className="shrink-0 text-muted-foreground">{m.source.kind}</span>
							<button type="button" aria-label="Delete memory" className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => void run(async () => void (await fetch(`/api/brain/memories?id=${encodeURIComponent(m.id)}`, { method: "DELETE" }).then(json)))}>
								×
							</button>
						</li>
					))}
				</ul>
			</SettingsGroup>

			{notice && <p className="mt-3 text-xs text-muted-foreground">{notice}</p>}
			{(error || status?.lastError) && (
				<p className="mt-3 text-xs text-destructive" role="alert">
					{error ?? status?.lastError}
				</p>
			)}
		</>
	);
}
