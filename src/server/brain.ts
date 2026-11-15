/**
 * The brain store service (docs/brain-store.md): sole writer of data/brain.
 *  - index: walk a vault, diff content-addressed chunks, embed only new
 *    ones with the LOCAL embedder (transformers.js, bge-small, offline after
 *    the one-time model download). No agent.
 *  - search: BM25 + cosine, RRF-fused, one wikilink hop (core/brain.ts).
 *  - bundle: `.brain.jsonl` export/import; mem0 / supermemory JSON import.
 *  - consolidate: mem0-style fact extraction + ADD/UPDATE/DELETE on the
 *    extractor slot — only when a session goes idle or a journal changes,
 *    never per query.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { piEngineForSpec } from "../agent/models.ts";
import {
	FACT_EXTRACTION_PROMPT,
	MEMORY_UPDATE_PROMPT,
	applyMemoryOps,
	brainHash,
	buildBm25,
	decodeBundle,
	encodeBundle,
	factExtractionInput,
	hybridSearch,
	importForeignMemories,
	memoryUpdateInput,
	noteRecords,
	normalizeVector,
	parseFacts,
	parseMemoryOps,
	planReindex,
	type Bm25Index,
	type BrainSearchOptions,
	type BundleOptions,
} from "../core/brain.ts";
import type { BrainHit, BrainRecord, BrainSnapshot, BrainSource, BrainStatus } from "../core/contracts/brain.ts";
import { serializeForSummary } from "../core/compaction.ts";
import { subscribe, type ServerEvent } from "../core/events.ts";
import { renderJournalMarkdown } from "../core/journal-export.ts";
import type { Embedder } from "../core/ports.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { vaultDir } from "./notes.ts";
import { stores } from "./stores.ts";

export class BrainError extends Error {
	constructor(
		message: string,
		readonly code: "invalid" | "busy" | "not_found",
	) {
		super(message);
	}
}

// ── Local embedder ─────────────────────────────────────────────────────────

const LOCAL_MODEL = "Xenova/bge-small-en-v1.5";
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

type Extractor = (texts: string[], opts: { pooling: "cls"; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

export function localEmbedder(): Embedder {
	let pipe: Promise<Extractor> | null = null;
	const load = () =>
		(pipe ??= import("@huggingface/transformers").then(async ({ pipeline, env }) => {
			env.cacheDir = path.join(PATHS.brain, "models");
			return (await pipeline("feature-extraction", LOCAL_MODEL, { dtype: "q8" })) as unknown as Extractor;
		}).catch((err: unknown) => {
			pipe = null;
			throw err;
		}));
	return {
		model: `${LOCAL_MODEL}@q8`,
		dims: 384,
		async embed(texts, kind) {
			const f = await load();
			const out: Float32Array[] = [];
			for (let i = 0; i < texts.length; i += 16) {
				const batch = texts.slice(i, i + 16).map((t) => (kind === "query" ? BGE_QUERY_PREFIX + t : t).slice(0, 2000));
				const t = await f(batch, { pooling: "cls", normalize: true });
				const d = t.dims[1]!;
				for (let r = 0; r < batch.length; r++) out.push(t.data.slice(r * d, (r + 1) * d));
			}
			return out;
		},
	};
}

// ── State (one per process) ────────────────────────────────────────────────

interface BrainState {
	snap: BrainSnapshot | null;
	bm25: Bm25Index | null;
	embedder: Embedder | null;
	indexing: boolean;
	progress: { done: number; total: number } | null;
	lastIndexed: string | null;
	lastConsolidated: string | null;
	lastError: string | null;
	timers: Map<string, ReturnType<typeof setTimeout>>;
	subscribed: boolean;
	/** Serializes every snapshot mutation (index, import, consolidation). */
	queue: Promise<unknown>;
}

function state(): BrainState {
	const g = globalThis as typeof globalThis & { __lhBrain?: BrainState };
	return (g.__lhBrain ??= {
		snap: null,
		bm25: null,
		embedder: null,
		indexing: false,
		progress: null,
		lastIndexed: null,
		lastConsolidated: null,
		lastError: null,
		timers: new Map(),
		subscribed: false,
		queue: Promise.resolve(),
	});
}

/** Tests inject a stub; production lazily builds the local embedder. */
export function setBrainEmbedder(e: Embedder | null): void {
	state().embedder = e;
}

function embedder(): Embedder {
	const s = state();
	return (s.embedder ??= localEmbedder());
}

function snapshot(): BrainSnapshot {
	const s = state();
	return (s.snap ??= stores.brainStore.load());
}

function bm25(): Bm25Index {
	const s = state();
	return (s.bm25 ??= buildBm25(snapshot().records.map((r) => r.text)));
}

function serial<T>(fn: () => Promise<T>): Promise<T> {
	const s = state();
	const run = s.queue.then(fn, fn);
	s.queue = run.catch(() => undefined);
	return run;
}

/** Rebuild the snapshot: keep `keep` rows, append `added` with vectors. A
 *  model change invalidates every vector, so callers re-embed first. */
function commit(base: BrainSnapshot, keep: (r: BrainRecord) => boolean, added: BrainRecord[], addedVecs: Float32Array[], patch: Partial<BrainSnapshot> = {}): BrainSnapshot {
	const e = embedder();
	const dims = e.dims;
	const sameModel = base.embedding?.model === e.model;
	const kept = base.records.map((r, i) => ({ r, i })).filter(({ r }) => keep(r));
	const records = [...kept.map((k) => k.r), ...added];
	const vectors = new Float32Array(records.length * dims);
	if (sameModel) kept.forEach(({ i }, row) => vectors.set(base.vectors.subarray(i * dims, (i + 1) * dims), row * dims));
	addedVecs.forEach((v, j) => vectors.set(v, (kept.length + j) * dims));
	const next: BrainSnapshot = { ...base, ...patch, embedding: { model: e.model, dims }, records, vectors };
	stores.brainStore.save(next);
	const s = state();
	s.snap = next;
	s.bm25 = null;
	return next;
}

/** Records whose stored vectors can't be trusted (model changed) — re-embed all. */
async function ensureModel(base: BrainSnapshot): Promise<BrainSnapshot> {
	const e = embedder();
	if (!base.records.length || base.embedding?.model === e.model) return base;
	const vecs = await embedRecords(base.records);
	const fresh = { ...base, embedding: null };
	return commit(fresh, () => false, base.records, vecs);
}

async function embedRecords(records: readonly BrainRecord[]): Promise<Float32Array[]> {
	const s = state();
	const out: Float32Array[] = [];
	for (let i = 0; i < records.length; i += 64) {
		const batch = records.slice(i, i + 64);
		out.push(...(await embedder().embed(batch.map((r) => r.text), "passage")).map(normalizeVector));
		if (s.progress) s.progress = { ...s.progress, done: Math.min(s.progress.total, s.progress.done + batch.length) };
	}
	return out;
}

// ── Vault indexing ─────────────────────────────────────────────────────────

const NOTES_VAULT = "notes";

function listMarkdown(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
			else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(rel);
		}
	};
	walk(root, "");
	return out;
}

function vaultNameFor(dir: string, vaults: Record<string, string>): string {
	const abs = path.resolve(dir);
	const existing = Object.entries(vaults).find(([, d]) => d === abs);
	if (existing) return existing[0];
	if (abs === path.resolve(vaultDir())) return NOTES_VAULT;
	const base = path.basename(abs) || "vault";
	let name = base;
	for (let n = 2; name in vaults; n++) name = `${base}-${n}`;
	return name;
}

/** Index (or re-index) a vault folder. Unchanged chunks keep their vectors;
 *  changed / new ones are embedded; vanished ones are dropped. */
export function indexVault(dir?: string): Promise<{ vault: string; added: number; dropped: number; kept: number }> {
	const abs = path.resolve(dir ?? vaultDir());
	if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return Promise.reject(new BrainError(`Not a folder: ${abs}`, "invalid"));
	return serial(async () => {
		const s = state();
		s.indexing = true;
		s.lastError = null;
		try {
			const base = await ensureModel(snapshot());
			const vault = vaultNameFor(abs, base.vaults);
			const now = new Date().toISOString();
			const fresh = new Map<string, BrainRecord[]>();
			for (const rel of listMarkdown(abs)) fresh.set(rel, noteRecords(rel, fs.readFileSync(path.join(abs, rel), "utf-8"), now, vault));
			const inVault = (r: BrainRecord) => r.type === "chunk" && (r.source.vault ?? NOTES_VAULT) === vault;
			const plan = planReindex(base.records.filter(inVault), fresh);
			s.progress = { done: 0, total: plan.add.length };
			const vecs = await embedRecords(plan.add);
			commit(base, (r) => !(inVault(r) && plan.drop.has(r.id)), plan.add, vecs, { vaults: { ...base.vaults, [vault]: abs } });
			s.lastIndexed = now;
			return { vault, added: plan.add.length, dropped: plan.drop.size, kept: plan.keep.size };
		} catch (err) {
			s.lastError = err instanceof Error ? err.message : String(err);
			throw err;
		} finally {
			s.indexing = false;
			s.progress = null;
		}
	});
}

/** Forget a vault: its chunks go; memories stay. */
export function removeVault(name: string): Promise<void> {
	return serial(async () => {
		const base = snapshot();
		if (!(name in base.vaults)) throw new BrainError(`Unknown vault: ${name}`, "not_found");
		const vaults = { ...base.vaults };
		delete vaults[name];
		commit(base, (r) => !(r.type === "chunk" && (r.source.vault ?? NOTES_VAULT) === name), [], [], { vaults });
	});
}

/** A note was saved in the app: re-index the notes vault shortly after
 *  (debounced — typing autosaves every 600 ms). Only once the learner has
 *  indexed the notes vault. */
export function brainNoteSaved(): void {
	if (!(NOTES_VAULT in snapshot().vaults)) return;
	debounce("vault:notes", 15_000, () => void indexVault(vaultDir()).catch(() => undefined));
}

// ── Search ─────────────────────────────────────────────────────────────────

export async function searchBrain(query: string, opts: BrainSearchOptions = {}): Promise<BrainHit[]> {
	const snap = snapshot();
	if (!query.trim() || !snap.records.length) return [];
	let qvec: Float32Array | null = null;
	if (snap.embedding?.model === embedder().model) {
		try {
			qvec = normalizeVector((await embedder().embed([query], "query"))[0]!);
		} catch (err) {
			console.error("[brain] query embedding failed, BM25 only:", err);
		}
	}
	return hybridSearch(snap, bm25(), query, qvec, opts);
}

export function brainStatus(): BrainStatus {
	const s = state();
	const snap = snapshot();
	const chunks = snap.records.filter((r) => r.type === "chunk");
	const count = (v: string) => chunks.filter((r) => (r.source.vault ?? NOTES_VAULT) === v).length;
	return {
		vaults: Object.entries(snap.vaults).map(([name, dir]) => ({ name, dir, chunks: count(name) })),
		embedding: snap.embedding,
		chunks: chunks.length,
		memories: snap.records.length - chunks.length,
		notes: new Set(chunks.map((r) => `${r.source.vault ?? ""}/${r.source.ref}`)).size,
		indexing: s.indexing,
		lastIndexed: s.lastIndexed,
		lastConsolidated: s.lastConsolidated,
		lastError: s.lastError,
		progress: s.progress,
	};
}

export function listMemories(): BrainRecord[] {
	return snapshot().records.filter((r) => r.type === "memory").sort((a, b) => b.updated.localeCompare(a.updated));
}

export function deleteMemory(id: string): Promise<void> {
	return serial(async () => {
		const base = snapshot();
		if (!base.records.some((r) => r.id === id && r.type === "memory")) throw new BrainError("Unknown memory.", "not_found");
		commit(base, (r) => r.id !== id, [], []);
	});
}

// ── Bundle ─────────────────────────────────────────────────────────────────

export function exportBrain(opts: BundleOptions = {}): string {
	return encodeBundle(snapshot(), opts);
}

/** Import a `.brain.jsonl` bundle, or a mem0 / supermemory JSON export.
 *  Records already present (same id, or a memory with the same text) are
 *  skipped. Bundled vectors are reused only when the embedding model
 *  matches ours; everything else is embedded locally. Imported note
 *  chunks keep their vault name but no folder (not re-indexable here). */
export function importBrain(text: string, fileName: string): Promise<{ added: number; skipped: number; format: "brain/1" | "foreign" }> {
	return serial(async () => {
		const s = state();
		s.lastError = null;
		const now = new Date().toISOString();
		let incoming: BrainRecord[];
		let incomingVecs: (Float32Array | null)[];
		let format: "brain/1" | "foreign";
		if (text.trimStart().startsWith('{"format":"brain/1"') || /^\s*\{[^\n]*"format"\s*:\s*"brain\/1"/.test(text)) {
			const b = decodeBundle(text);
			const reuse = b.manifest.embedding?.model === embedder().model;
			incoming = b.records;
			incomingVecs = b.vectors.map((v) => (reuse && v?.length === embedder().dims ? normalizeVector(v) : null));
			format = "brain/1";
		} else {
			incoming = importForeignMemories(text, fileName, now);
			incomingVecs = incoming.map(() => null);
			format = "foreign";
		}
		if (!incoming.length) throw new BrainError("Nothing importable found (expected a .brain.jsonl bundle or a mem0 / supermemory JSON export).", "invalid");
		const base = await ensureModel(snapshot());
		const ids = new Set(base.records.map((r) => r.id));
		const memHashes = new Set(base.records.filter((r) => r.type === "memory").map((r) => r.hash));
		const take: { r: BrainRecord; v: Float32Array | null }[] = [];
		incoming.forEach((r, i) => {
			if (ids.has(r.id) || (r.type === "memory" && memHashes.has(r.hash))) return;
			ids.add(r.id);
			if (r.type === "memory") memHashes.add(r.hash);
			take.push({ r, v: incomingVecs[i] ?? null });
		});
		const need = take.filter((t) => !t.v);
		s.progress = { done: 0, total: need.length };
		try {
			const vecs = await embedRecords(need.map((t) => t.r));
			need.forEach((t, i) => (t.v = vecs[i]!));
		} finally {
			s.progress = null;
		}
		commit(base, () => true, take.map((t) => t.r), take.map((t) => t.v!));
		return { added: take.length, skipped: incoming.length - take.length, format };
	});
}

// ── Consolidation ──────────────────────────────────────────────────────────

const SESSION_IDLE_MS = 10 * 60_000;
const JOURNAL_IDLE_MS = 2 * 60_000;
const MATERIAL_MAX = 16_000;

/** One non-streamed completion on the extractor slot. */
async function complete(system: string, user: string): Promise<string> {
	const spec = resolveRoleSpec("extractor", stores.settingsStore.readSettings());
	if (!spec) throw new BrainError("No model for memory consolidation — set the cheap/strong slot in Settings → Models.", "invalid");
	const engine = piEngineForSpec(spec, false);
	const stream = engine.streamFn(
		engine.model,
		normalizeContext({ systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }], tools: [] }),
		{ sessionId: `brain-${Date.now()}`, reasoning: engine.level && engine.level !== "off" ? engine.level : undefined } as never,
	);
	let text = "";
	for await (const event of stream) {
		if (event.type === "text_delta") text += event.delta;
		else if (event.type === "error") throw new Error(event.error.errorMessage ?? "model error");
		else if (event.type === "done") break;
	}
	return text;
}

/** mem0's two-step loop over `material`: extract facts → for each, find
 *  similar memories → one reconcile call → apply ADD/UPDATE/DELETE. The
 *  model calls run outside the write queue; only the apply is serialized. */
export async function consolidate(material: string, source: BrainSource, watermark?: { key: string; value: string | number }): Promise<{ facts: number; added: number; updated: number; deleted: number }> {
	const s = state();
	const facts = parseFacts(await complete(FACT_EXTRACTION_PROMPT, factExtractionInput(material.slice(-MATERIAL_MAX))));
	const similar = new Map<string, BrainRecord>();
	for (const f of facts) for (const h of await searchBrain(f, { k: 5, types: ["memory"], expandLinks: false })) similar.set(h.record.id, h.record);
	const { prompt, ids } = memoryUpdateInput([...similar.values()], facts);
	const ops = facts.length ? parseMemoryOps(await complete(MEMORY_UPDATE_PROMPT, prompt), ids) : [];
	return serial(async () => {
		const base = await ensureModel(snapshot());
		const now = new Date().toISOString();
		const applied = applyMemoryOps(ops, new Map(base.records.map((r) => [r.id, r])), source, now);
		const replaced = new Set(applied.upserts.map((r) => r.id));
		const vecs = await embedRecords(applied.upserts);
		commit(base, (r) => !applied.deletes.has(r.id) && !replaced.has(r.id), applied.upserts, vecs, watermark ? { watermarks: { ...base.watermarks, [watermark.key]: watermark.value } } : {});
		s.lastConsolidated = now;
		const updated = applied.upserts.filter((r) => base.records.some((b) => b.id === r.id)).length;
		return { facts: facts.length, added: applied.upserts.length - updated, updated, deleted: applied.deletes.size };
	});
}

/** Consolidate a session's messages since its watermark. */
export async function consolidateSession(chatId: string): Promise<{ facts: number; added: number; updated: number; deleted: number } | null> {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) throw new BrainError("Unknown session.", "not_found");
	const key = `chat:${chatId}`;
	const from = Number(snapshot().watermarks[key] ?? 0);
	const fresh = chat.messages.slice(from);
	if (fresh.filter((m) => m.role === "user").length === 0) return null;
	const material = serializeForSummary(fresh);
	if (!material.trim()) return null;
	return consolidate(material, { kind: "session", ref: chatId }, { key, value: chat.messages.length });
}

export async function consolidateJournal(journalId: string): Promise<{ facts: number; added: number; updated: number; deleted: number } | null> {
	const journal = stores.journalStore.getJournal(journalId);
	if (!journal) throw new BrainError("Unknown journal.", "not_found");
	const md = renderJournalMarkdown(journal);
	const key = `journal:${journalId}`;
	const hash = brainHash(md);
	if (snapshot().watermarks[key] === hash) return null;
	return consolidate(md, { kind: "journal", ref: journalId }, { key, value: hash });
}

function debounce(key: string, ms: number, fn: () => void): void {
	const s = state();
	const t = s.timers.get(key);
	if (t) clearTimeout(t);
	const next = setTimeout(() => {
		s.timers.delete(key);
		fn();
	}, ms);
	next.unref?.();
	s.timers.set(key, next);
}

/** Automatic consolidation: a session idle for 10 min, a journal quiet for
 *  2 min. Only when the brain is in use (anything indexed or imported) and
 *  a model is set; failures land in status.lastError, never in the turn. */
export function startBrainAutoConsolidation(): void {
	const s = state();
	if (s.subscribed || process.env.NODE_ENV === "test") return;
	s.subscribed = true;
	const run = (p: Promise<unknown>) =>
		void p.catch((err: unknown) => {
			state().lastError = `consolidation: ${err instanceof Error ? err.message : String(err)}`;
		});
	subscribe((event) => {
		if (!snapshot().records.length) return;
		if (event.type === "turn-settled") {
			const { chatId } = event as ServerEvent<"turn-settled">;
			debounce(`chat:${chatId}`, SESSION_IDLE_MS, () => run(consolidateSession(chatId)));
		} else if (event.type === "journals-changed") {
			const { journalId } = event as ServerEvent<"journals-changed">;
			debounce(`journal:${journalId}`, JOURNAL_IDLE_MS, () => run(consolidateJournal(journalId)));
		}
	});
}

startBrainAutoConsolidation();

/** Route wrapper: BrainError → 400/404/409, else 500. */
export async function brainRoute(fn: () => Response | Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof BrainError) return Response.json({ error: err.message, code: err.code }, { status: err.code === "not_found" ? 404 : err.code === "busy" ? 409 : 400 });
		if (err instanceof SyntaxError) return Response.json({ error: "Body must be JSON.", code: "invalid" }, { status: 400 });
		console.error("[brain] route failed:", err);
		return Response.json({ error: err instanceof Error ? err.message : "Brain operation failed." }, { status: 500 });
	}
}
