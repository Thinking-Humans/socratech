/**
 * The brain store's pure domain (docs/brain-store.md): Obsidian markdown →
 * chunks, incremental re-index planning, BM25 + vector hybrid search with
 * one-hop wikilink expansion, the portable `.brain.jsonl` bundle, mem0 /
 * supermemory import mapping, and mem0-style consolidation (ADD / UPDATE /
 * DELETE / NONE). Browser-safe, no IO.
 */

import type { BrainHit, BrainManifest, BrainRecord, BrainSnapshot, BrainSource, MemoryOp } from "./contracts/brain.ts";

// ── Hashing ────────────────────────────────────────────────────────────────

/** 64-bit content hash (two FNV-1a 32 lanes), 16 hex chars. Not crypto. */
export function brainHash(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ 0x5bd1e995;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193);
		b = Math.imul(b ^ c ^ (i & 0xff), 0x5bd1e995);
	}
	return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

// ── Obsidian parsing ───────────────────────────────────────────────────────

export const CHUNK_MAX_CHARS = 1500;

export interface ParsedChunk {
	heading: string;
	text: string;
	links: string[];
	tags: string[];
}

export interface ParsedNote {
	title: string;
	tags: string[];
	aliases: string[];
	links: string[];
	chunks: ParsedChunk[];
}

/** Obsidian resolves `[[Target]]` by basename: lowercase, no folder, no `.md`. */
export function normalizeLinkTarget(target: string): string {
	const base = target.split("#")[0]!.split("|")[0]!.trim().split("/").pop() ?? "";
	return base.replace(/\.md$/i, "").toLowerCase();
}

export function noteTitle(path: string): string {
	return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

const WIKILINK_RE = /!?\[\[([^\]\n]+?)\]\]/g;
const TAG_RE = /(?:^|[\s(])#([\p{L}_][\p{L}\p{N}_/-]*)/gu;

function uniq(xs: string[]): string[] {
	return [...new Set(xs.filter(Boolean))];
}

function yamlList(value: string, block: string[]): string[] {
	const v = value.trim();
	if (v.startsWith("[")) return v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
	if (v) return v.split(/[,\s]+/).map((s) => s.replace(/^["']|["']$/g, "")).filter(Boolean);
	return block.map((l) => l.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** Minimal frontmatter: `tags` and `aliases` (inline list, flow list, or block list). */
function frontmatter(content: string): { body: string; tags: string[]; aliases: string[] } {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return { body: content, tags: [], aliases: [] };
	const lines = m[1]!.split(/\r?\n/);
	const out: Record<string, string[]> = {};
	for (let i = 0; i < lines.length; i++) {
		const kv = lines[i]!.match(/^(tags|aliases|tag|alias):\s*(.*)$/i);
		if (!kv) continue;
		const block: string[] = [];
		while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]!)) block.push(lines[++i]!);
		const key = kv[1]!.toLowerCase().replace(/s?$/, "s");
		out[key] = [...(out[key] ?? []), ...yamlList(kv[2]!, block)];
	}
	return { body: content.slice(m[0].length), tags: (out.tags ?? []).map((t) => t.replace(/^#/, "")), aliases: out.aliases ?? [] };
}

function linksIn(text: string): string[] {
	return uniq([...text.matchAll(WIKILINK_RE)].map((m) => normalizeLinkTarget(m[1]!)));
}

function tagsIn(text: string): string[] {
	return uniq([...text.matchAll(TAG_RE)].map((m) => m[1]!));
}

/** Split an over-long section on paragraph (then line) boundaries. */
function splitLong(text: string, max = CHUNK_MAX_CHARS): string[] {
	if (text.length <= max) return [text];
	const parts: string[] = [];
	let cur = "";
	for (const para of text.split(/\n{2,}/)) {
		const pieces = para.length > max ? para.match(new RegExp(`[\\s\\S]{1,${max}}(?=\\s|$)`, "g")) ?? [para] : [para];
		for (const p of pieces) {
			if (cur && cur.length + p.length + 2 > max) {
				parts.push(cur);
				cur = "";
			}
			cur = cur ? `${cur}\n\n${p}` : p;
		}
	}
	if (cur) parts.push(cur);
	return parts;
}

/** One Obsidian note → heading-scoped chunks. HTML comments (journey
 *  markers) and empty sections are dropped; code fences are kept as text
 *  but never split on their `#` lines. */
export function parseNote(path: string, content: string): ParsedNote {
	const fm = frontmatter(content.replace(/<!--[\s\S]*?-->/g, ""));
	const title = noteTitle(path);
	const lines = fm.body.split(/\r?\n/);
	const sections: { heading: string; lines: string[] }[] = [];
	const stack: string[] = [];
	let cur = { heading: "", lines: [] as string[] };
	let fence: string | null = null;
	for (const line of lines) {
		const f = line.match(/^\s*(```+|~~~+)/);
		if (f) fence = fence ? (line.trim().startsWith(fence) ? null : fence) : f[1]!;
		const h = fence ? null : line.match(/^(#{1,6})\s+(.*\S)\s*$/);
		if (h) {
			sections.push(cur);
			const depth = h[1]!.length;
			stack.length = depth - 1;
			stack[depth - 1] = h[2]!;
			cur = { heading: stack.filter(Boolean).join(" > "), lines: [line] };
		} else cur.lines.push(line);
	}
	sections.push(cur);
	const chunks: ParsedChunk[] = [];
	for (const s of sections) {
		const text = s.lines.join("\n").trim();
		const body = s.lines.slice(s.heading ? 1 : 0).join("\n").trim();
		if (!body) continue;
		for (const piece of splitLong(text)) {
			const withTitle = s.heading && piece !== text ? `${s.lines[0]}\n${piece}` : piece;
			chunks.push({ heading: s.heading, text: withTitle, links: linksIn(piece), tags: tagsIn(piece) });
		}
	}
	return { title, tags: uniq([...fm.tags, ...tagsIn(fm.body)]), aliases: fm.aliases, links: linksIn(fm.body), chunks };
}

/** The records a note contributes: chunk text is prefixed with the note
 *  title (retrieval context), tags = note-level ∪ chunk-level. */
export function noteRecords(path: string, content: string, now: string, vault?: string): BrainRecord[] {
	const note = parseNote(path, content);
	const seen = new Set<string>();
	const out: BrainRecord[] = [];
	for (const c of note.chunks) {
		const text = `${note.title}${c.heading ? ` — ${c.heading}` : ""}\n\n${c.text.replace(/^#{1,6}\s+.*\n?/, "").trim()}`;
		const hash = brainHash(text);
		const key = `${vault ?? ""}\0${path}\0${hash}`;
		let id = `c_${brainHash(key)}`;
		for (let n = 1; seen.has(id); n++) id = `c_${brainHash(`${key}\0${n}`)}`;
		seen.add(id);
		out.push({
			id,
			type: "chunk",
			text,
			source: { kind: "note", ref: path, ...(vault ? { vault } : {}), ...(c.heading ? { heading: c.heading } : {}) },
			links: c.links,
			tags: uniq([...note.tags, ...c.tags]),
			hash,
			created: now,
			updated: now,
		});
	}
	return out;
}

// ── Incremental re-index ───────────────────────────────────────────────────

export interface ReindexPlan {
	/** Existing chunk ids to keep (same content → same id → no re-embed). */
	keep: Set<string>;
	/** New records needing an embedding. */
	add: BrainRecord[];
	/** Existing chunk ids to drop (changed or vanished). */
	drop: Set<string>;
}

/** Diff the vault's current chunks against the stored ones. `fresh` maps
 *  path → that file's records (from noteRecords); paths absent from it are
 *  deleted notes. Memories are never touched. */
export function planReindex(existing: readonly BrainRecord[], fresh: ReadonlyMap<string, BrainRecord[]>): ReindexPlan {
	const have = new Map(existing.filter((r) => r.type === "chunk").map((r) => [r.id, r]));
	const keep = new Set<string>();
	const add: BrainRecord[] = [];
	for (const recs of fresh.values())
		for (const r of recs) {
			if (have.has(r.id)) keep.add(r.id);
			else add.push(r);
		}
	const drop = new Set([...have.keys()].filter((id) => !keep.has(id)));
	return { keep, add, drop };
}

// ── BM25 ───────────────────────────────────────────────────────────────────

const STOP = new Set(
	"a an and are as at be but by for from has have i if in into is it its of on or that the this to was were what when where which who why will with you your".split(" "),
);

export function tokenize(text: string): string[] {
	return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

export interface Bm25Index {
	score(query: string): Map<number, number>;
}

export function buildBm25(texts: readonly string[], k1 = 1.2, b = 0.75): Bm25Index {
	const postings = new Map<string, [number, number][]>();
	const lens = new Float32Array(texts.length);
	texts.forEach((t, i) => {
		const toks = tokenize(t);
		lens[i] = toks.length;
		const tf = new Map<string, number>();
		for (const tok of toks) tf.set(tok, (tf.get(tok) ?? 0) + 1);
		for (const [tok, n] of tf) {
			let p = postings.get(tok);
			if (!p) postings.set(tok, (p = []));
			p.push([i, n]);
		}
	});
	const N = texts.length;
	const avg = N ? lens.reduce((s, x) => s + x, 0) / N : 0;
	return {
		score(query) {
			const out = new Map<number, number>();
			for (const tok of new Set(tokenize(query))) {
				const p = postings.get(tok);
				if (!p) continue;
				const idf = Math.log(1 + (N - p.length + 0.5) / (p.length + 0.5));
				for (const [i, tf] of p) out.set(i, (out.get(i) ?? 0) + (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * lens[i]!) / (avg || 1))));
			}
			return out;
		},
	};
}

// ── Vectors ────────────────────────────────────────────────────────────────

export function normalizeVector(v: Float32Array): Float32Array {
	let s = 0;
	for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
	const n = Math.sqrt(s) || 1;
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
	return out;
}

/** Dot product of `q` against every row (rows normalized → cosine). */
export function vectorScores(vectors: Float32Array, dims: number, q: Float32Array): Float32Array {
	const rows = dims ? Math.floor(vectors.length / dims) : 0;
	const out = new Float32Array(rows);
	for (let r = 0; r < rows; r++) {
		let s = 0;
		const o = r * dims;
		for (let d = 0; d < dims; d++) s += vectors[o + d]! * q[d]!;
		out[r] = s;
	}
	return out;
}

function topK(scores: Iterable<[number, number]>, k: number): [number, number][] {
	return [...scores].sort((x, y) => y[1] - x[1]).slice(0, k);
}

// ── Hybrid search ──────────────────────────────────────────────────────────

export interface BrainSearchOptions {
	k?: number;
	/** Candidate depth per ranker before fusion. */
	depth?: number;
	/** One wikilink hop from the top matches (default true). */
	expandLinks?: boolean;
	types?: BrainRecord["type"][];
}

/** Reciprocal-rank fusion of BM25 and cosine, then one wikilink hop:
 *  records of notes the top matches link to (and that link to them) join
 *  at half the linking hit's score. `qvec` null → BM25 only. */
export function hybridSearch(snap: BrainSnapshot, bm25: Bm25Index, query: string, qvec: Float32Array | null, opts: BrainSearchOptions = {}): BrainHit[] {
	const { k = 8, depth = 50, expandLinks = true, types } = opts;
	const allowed = (i: number) => !types || types.includes(snap.records[i]!.type);
	const fused = new Map<number, number>();
	const RRF = 60;
	const add = (ranked: [number, number][]) =>
		ranked.forEach(([i], rank) => {
			fused.set(i, (fused.get(i) ?? 0) + 1 / (RRF + rank + 1));
		});
	add(topK([...bm25.score(query)].filter(([i]) => allowed(i)), depth));
	if (qvec && snap.embedding) {
		const vs = vectorScores(snap.vectors, snap.embedding.dims, qvec);
		add(topK([...vs.entries()].filter(([i]) => allowed(i)), depth));
	}
	const hits: { i: number; score: number; via: "match" | "link" }[] = topK(fused, k).map(([i, score]) => ({ i, score, via: "match" as const }));
	if (expandLinks && hits.length) {
		const byTitle = new Map<string, number[]>();
		snap.records.forEach((r, i) => {
			if (r.source.kind !== "note" || !allowed(i)) return;
			const t = noteTitle(r.source.ref).toLowerCase();
			byTitle.set(t, [...(byTitle.get(t) ?? []), i]);
		});
		const taken = new Set(hits.map((h) => h.i));
		const extra: { i: number; score: number; via: "link" }[] = [];
		for (const h of hits) {
			const r = snap.records[h.i]!;
			const targets = new Set(r.links);
			const self = r.source.kind === "note" ? noteTitle(r.source.ref).toLowerCase() : null;
			const neighbours: number[] = [];
			for (const t of targets) neighbours.push(...(byTitle.get(t) ?? []));
			if (self) snap.records.forEach((o, i) => o.links.includes(self) && neighbours.push(i));
			// Best chunk per neighbour note: the one with the highest query BM25, else first.
			const perNote = new Map<string, number>();
			for (const i of neighbours) {
				if (taken.has(i)) continue;
				const ref = snap.records[i]!.source.ref;
				if (!perNote.has(ref)) perNote.set(ref, i);
			}
			for (const i of perNote.values()) {
				taken.add(i);
				extra.push({ i, score: h.score / 2, via: "link" });
			}
		}
		hits.push(...topK(extra.map((e) => [e.i, e.score] as [number, number]), Math.ceil(k / 2)).map(([i, score]) => ({ i, score, via: "link" as const })));
	}
	return hits.map((h) => ({ record: snap.records[h.i]!, score: h.score, via: h.via }));
}

/** Context block for a prompt: hits as cited markdown, capped. */
export function formatBrainContext(hits: readonly BrainHit[], maxChars = 6000): string {
	const parts: string[] = [];
	let used = 0;
	for (const h of hits) {
		const src = h.record.source.kind === "note" ? `[[${noteTitle(h.record.source.ref)}]]` : `${h.record.source.kind}:${h.record.source.ref}`;
		const block = `- (${src}${h.via === "link" ? ", linked" : ""}) ${h.record.text.replace(/\s+/g, " ").trim()}`;
		if (used + block.length > maxChars) break;
		parts.push(block);
		used += block.length;
	}
	return parts.join("\n");
}

// ── Bundle (.brain.jsonl) ──────────────────────────────────────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToB64(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
		out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=") + (i + 2 < bytes.length ? B64[n & 63]! : "=");
	}
	return out;
}

function b64ToBytes(s: string): Uint8Array {
	const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
	const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
	let o = 0;
	for (let i = 0; i < clean.length; i += 4) {
		const n = (B64.indexOf(clean[i]!) << 18) | (B64.indexOf(clean[i + 1]!) << 12) | ((B64.indexOf(clean[i + 2] ?? "A") & 63) << 6) | (B64.indexOf(clean[i + 3] ?? "A") & 63);
		out[o++] = (n >> 16) & 255;
		if (o < out.length) out[o++] = (n >> 8) & 255;
		if (o < out.length) out[o++] = n & 255;
	}
	return out;
}

export function vectorToB64(v: Float32Array): string {
	const le = new Uint8Array(v.length * 4);
	const dv = new DataView(le.buffer);
	v.forEach((x, i) => dv.setFloat32(i * 4, x, true));
	return bytesToB64(le);
}

export function b64ToVector(s: string): Float32Array {
	const bytes = b64ToBytes(s);
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out = new Float32Array(Math.floor(bytes.length / 4));
	for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
	return out;
}

export interface BundleOptions {
	/** Include note chunks (default true) — memories are always included. */
	chunks?: boolean;
	vectors?: boolean;
	app?: string;
	now?: string;
}

export function encodeBundle(snap: BrainSnapshot, opts: BundleOptions = {}): string {
	const { chunks = true, vectors = true, app = "socratech", now = new Date().toISOString() } = opts;
	const dims = snap.embedding?.dims ?? 0;
	const rows = snap.records.map((r, i) => ({ r, i })).filter(({ r }) => chunks || r.type === "memory");
	const manifest: BrainManifest = { format: "brain/1", exported: now, app, embedding: vectors ? snap.embedding : null, count: rows.length };
	const lines = [JSON.stringify(manifest)];
	for (const { r, i } of rows) {
		const v = vectors && dims ? vectorToB64(snap.vectors.subarray(i * dims, (i + 1) * dims)) : undefined;
		lines.push(JSON.stringify(v ? { ...r, v } : r));
	}
	return `${lines.join("\n")}\n`;
}

export interface DecodedBundle {
	manifest: BrainManifest;
	records: BrainRecord[];
	/** Parallel to records; null where the line carried no vector. */
	vectors: (Float32Array | null)[];
}

function isRecord(x: unknown): x is BrainRecord {
	const r = x as BrainRecord;
	return typeof r === "object" && r !== null && typeof r.id === "string" && typeof r.text === "string" && (r.type === "chunk" || r.type === "memory") && typeof r.source?.ref === "string";
}

export function decodeBundle(text: string): DecodedBundle {
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	const manifest = JSON.parse(lines[0] ?? "null") as BrainManifest | null;
	if (manifest?.format !== "brain/1") throw new Error("Not a brain/1 bundle (first line must be its manifest).");
	const records: BrainRecord[] = [];
	const vectors: (Float32Array | null)[] = [];
	for (const line of lines.slice(1)) {
		const raw = JSON.parse(line) as BrainRecord & { v?: string };
		if (!isRecord(raw)) continue;
		const { v, ...rec } = raw;
		records.push({ ...rec, links: Array.isArray(rec.links) ? rec.links : [], tags: Array.isArray(rec.tags) ? rec.tags : [], hash: rec.hash || brainHash(rec.text) });
		vectors.push(v && manifest.embedding ? b64ToVector(v) : null);
	}
	return { manifest, records, vectors };
}

// ── mem0 / supermemory import ──────────────────────────────────────────────

/** A memory record from free-standing text (import / consolidation). */
export function newMemory(text: string, source: BrainSource, now: string, extra: { tags?: string[]; created?: string; updated?: string } = {}): BrainRecord {
	const clean = text.trim();
	return {
		id: `m_${brainHash(`${source.kind}\0${clean}\0${now}`)}`,
		type: "memory",
		text: clean,
		source,
		links: linksIn(clean),
		tags: uniq([...(extra.tags ?? []), ...tagsIn(clean)]),
		hash: brainHash(clean),
		created: extra.created ?? now,
		updated: extra.updated ?? extra.created ?? now,
	};
}

/** mem0 (`memory`, `categories`, `created_at`), supermemory (`content`,
 *  `metadata`), or anything with `text` — as an array, `{results}`,
 *  `{memories}`, `{documents}`, or JSONL. */
export function importForeignMemories(text: string, sourceName: string, now: string): BrainRecord[] {
	let items: unknown[];
	try {
		const parsed = JSON.parse(text) as unknown;
		const o = parsed as Record<string, unknown>;
		items = Array.isArray(parsed) ? parsed : ((o.results ?? o.memories ?? o.documents ?? o.data ?? []) as unknown[]);
	} catch {
		items = text
			.split(/\r?\n/)
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l) as unknown);
	}
	const out: BrainRecord[] = [];
	const seen = new Set<string>();
	for (const it of items) {
		const o = (it ?? {}) as Record<string, unknown>;
		const body = [o.memory, o.content, o.text, o.summary].find((x) => typeof x === "string" && x.trim()) as string | undefined;
		if (!body) continue;
		const meta = (o.metadata ?? {}) as Record<string, unknown>;
		const tags = [o.categories, o.tags, meta.tags, meta.categories, o.containerTags].flatMap((x) => (Array.isArray(x) ? x.filter((t): t is string => typeof t === "string") : []));
		const created = [o.created_at, o.createdAt, o.created].find((x) => typeof x === "string") as string | undefined;
		const updated = [o.updated_at, o.updatedAt, o.updated].find((x) => typeof x === "string") as string | undefined;
		const rec = newMemory(body, { kind: "import", ref: sourceName }, now, { tags, ...(created ? { created } : {}), ...(updated ? { updated } : {}) });
		if (seen.has(rec.hash)) continue;
		seen.add(rec.hash);
		out.push(rec);
	}
	return out;
}

// ── Consolidation (mem0-style) ─────────────────────────────────────────────

export const FACT_EXTRACTION_PROMPT = `You maintain a learner's long-term memory (their "second brain"). From the material below, extract durable facts worth remembering about the learner and what they know: concepts they now understand (stated precisely), misconceptions they had or still have, goals, interests, open questions, and preferences about how they learn.

Rules:
- One self-contained fact per item, written in the third person ("The learner …") or as a precise statement of the idea learned.
- Skip small talk, transient logistics, and anything only the tutor said that the learner did not engage with.
- Return ONLY JSON: {"facts": ["…", "…"]}. Return {"facts": []} if nothing is worth keeping.`;

export const MEMORY_UPDATE_PROMPT = `You reconcile new facts into a learner's existing memories. For each new fact decide one operation:
- ADD: new information not covered by any existing memory.
- UPDATE: an existing memory covers the same thing but the new fact refines, corrects, or extends it — give the id and the merged text.
- DELETE: the new fact shows an existing memory is now wrong (e.g. a misconception that was fixed) — give the id.
- NONE: already covered; nothing to change.

Return ONLY JSON: {"memory": [{"op": "ADD", "text": "…"}, {"op": "UPDATE", "id": "2", "text": "…"}, {"op": "DELETE", "id": "0"}, {"op": "NONE", "id": "1"}]}`;

export function factExtractionInput(material: string): string {
	return `Material:\n\n${material}`;
}

/** Existing memories get short positional ids ("0", "1", …) — models copy
 *  short ids reliably; `ids[n]` maps them back. */
export function memoryUpdateInput(existing: readonly BrainRecord[], facts: readonly string[]): { prompt: string; ids: string[] } {
	const ids = existing.map((r) => r.id);
	const old = existing.map((r, i) => ({ id: String(i), text: r.text }));
	return { prompt: `Existing memories:\n${JSON.stringify(old, null, 1)}\n\nNew facts:\n${JSON.stringify(facts, null, 1)}`, ids };
}

/** First JSON object/array in a model reply (tolerates prose + fences). */
export function extractJson(reply: string): unknown {
	const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
	const s = fenced ? fenced[1]! : reply;
	const start = s.search(/[[{]/);
	if (start < 0) return null;
	for (let end = s.length; end > start; end--) {
		const ch = s[end - 1];
		if (ch !== "}" && ch !== "]") continue;
		try {
			return JSON.parse(s.slice(start, end));
		} catch {
			// keep shrinking
		}
	}
	return null;
}

export function parseFacts(reply: string): string[] {
	const j = extractJson(reply) as { facts?: unknown } | unknown[] | null;
	const arr = Array.isArray(j) ? j : (j as { facts?: unknown } | null)?.facts;
	return Array.isArray(arr) ? arr.filter((f): f is string => typeof f === "string" && f.trim().length > 0).map((f) => f.trim()) : [];
}

/** Model ops with positional ids mapped back to record ids; ops naming an
 *  unknown id are dropped (never guess which memory was meant). */
export function parseMemoryOps(reply: string, ids: readonly string[]): MemoryOp[] {
	const j = extractJson(reply) as { memory?: unknown } | unknown[] | null;
	const arr = Array.isArray(j) ? j : (j as { memory?: unknown } | null)?.memory;
	if (!Array.isArray(arr)) return [];
	const out: MemoryOp[] = [];
	for (const raw of arr) {
		const o = (raw ?? {}) as { op?: unknown; event?: unknown; id?: unknown; text?: unknown };
		const op = String(o.op ?? o.event ?? "").toUpperCase();
		const id = o.id === undefined ? undefined : ids[Number(o.id)];
		const text = typeof o.text === "string" ? o.text.trim() : "";
		if (op === "ADD" && text) out.push({ op: "ADD", text });
		else if (op === "UPDATE" && id && text) out.push({ op: "UPDATE", id, text });
		else if (op === "DELETE" && id) out.push({ op: "DELETE", id });
		else if (op === "NONE") out.push(id ? { op: "NONE", id } : { op: "NONE" });
	}
	return out;
}

export interface AppliedOps {
	/** New or rewritten memory records (need embedding). */
	upserts: BrainRecord[];
	deletes: Set<string>;
}

export function applyMemoryOps(ops: readonly MemoryOp[], existing: ReadonlyMap<string, BrainRecord>, source: BrainSource, now: string): AppliedOps {
	const upserts: BrainRecord[] = [];
	const deletes = new Set<string>();
	for (const op of ops) {
		if (op.op === "ADD") upserts.push(newMemory(op.text, source, now));
		else if (op.op === "UPDATE") {
			const old = existing.get(op.id);
			if (!old || old.type !== "memory") continue;
			upserts.push({ ...old, text: op.text, hash: brainHash(op.text), links: linksIn(op.text), tags: uniq([...old.tags, ...tagsIn(op.text)]), updated: now });
		} else if (op.op === "DELETE" && existing.get(op.id)?.type === "memory") deletes.add(op.id);
	}
	return { upserts, deletes };
}
