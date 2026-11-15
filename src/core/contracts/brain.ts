/**
 * Brain store contracts (docs/brain-store.md): the learner's second brain as
 * one flat list of records — note chunks (deterministic, re-derived from the
 * vault) and memories (mem0-shaped facts, written by consolidation or
 * import) — each with one embedding row.
 */

export type BrainRecordType = "chunk" | "memory";
export type BrainSourceKind = "note" | "session" | "journal" | "import";

export interface BrainSource {
	kind: BrainSourceKind;
	/** Vault-relative path (note), chatId (session), journalId (journal), or
	 *  the imported bundle/file name (import). */
	ref: string;
	/** Notes only: the vault's name (BrainSnapshot.vaults key) — paths are
	 *  vault-relative so a bundle never carries a machine's absolute paths. */
	vault?: string;
	/** Heading path inside a note, "H1 > H2". */
	heading?: string;
}

export interface BrainRecord {
	/** "c_<hash>" for chunks (content-addressed), "m_<hash>" for memories. */
	id: string;
	type: BrainRecordType;
	text: string;
	source: BrainSource;
	/** Normalized wikilink targets (lowercase note basenames). */
	links: string[];
	tags: string[];
	/** Content hash of `text` — re-embed only when it changes. */
	hash: string;
	created: string;
	updated: string;
}

export interface BrainEmbeddingInfo {
	model: string;
	dims: number;
}

/** The in-memory store: records + one row per record in `vectors`
 *  (row i ↔ records[i], L2-normalized, `dims` floats each). */
export interface BrainSnapshot {
	embedding: BrainEmbeddingInfo | null;
	records: BrainRecord[];
	vectors: Float32Array;
	/** Consolidation watermarks: "chat:<id>" → messages consumed,
	 *  "journal:<id>" → content hash consumed. */
	watermarks: Record<string, string | number>;
	/** Indexed vaults: name → absolute directory (machine-local, never exported). */
	vaults: Record<string, string>;
}

/** `.brain.jsonl` line 1. Every later line is a BrainRecord, optionally
 *  with `v` = base64 little-endian float32 vector (only when the reader's
 *  model matches `embedding.model` can it skip re-embedding). */
export interface BrainManifest {
	format: "brain/1";
	exported: string;
	app: string;
	embedding: BrainEmbeddingInfo | null;
	count: number;
}

export interface BrainHit {
	record: BrainRecord;
	score: number;
	/** "match" = ranked by search; "link" = pulled in one wikilink hop away. */
	via: "match" | "link";
}

export interface BrainStatus {
	vaults: { name: string; dir: string; chunks: number }[];
	embedding: BrainEmbeddingInfo | null;
	chunks: number;
	memories: number;
	notes: number;
	indexing: boolean;
	lastIndexed: string | null;
	lastConsolidated: string | null;
	lastError: string | null;
	/** Index progress while `indexing`: embedded / to embed. */
	progress: { done: number; total: number } | null;
}

/** mem0-style memory operation, as the consolidation model returns it. */
export type MemoryOp =
	| { op: "ADD"; text: string }
	| { op: "UPDATE"; id: string; text: string }
	| { op: "DELETE"; id: string }
	| { op: "NONE"; id?: string };
