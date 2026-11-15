/**
 * Journal — the learn-in-public domain (docs/learn-in-public.md, owner
 * 2026-11-15). A journal is a cell list: exercises posed in practice or
 * improvisation, the learner's attempts and the verdicts on them (filled
 * in automatically), plus what the learner writes — reflections, asides,
 * code. Each cell carries its own publish switch; the exporter
 * (core/journal-export.ts) drops every cell whose switch is off, so the
 * stored journal is the private working copy and the bundle is the public
 * artifact.
 *
 * Pure types + constants: browser-safe.
 */

/** What a cell is. Order is the UI's role-picker order. */
export const JOURNAL_CELL_ROLES = ["reflection", "aside", "code", "exercise", "attempt", "verdict"] as const;
export type JournalCellRole = (typeof JOURNAL_CELL_ROLES)[number];

/** Default visibility by role (owner, 2026-11-15, D3/D4/Q2): exercise
 *  statements, reflections and code publish; attempts, verdicts and asides
 *  stay private until the learner flips the cell's switch. Code publishes
 *  as a static block — never executable. */
export const DEFAULT_PUBLISH: Readonly<Record<JournalCellRole, boolean>> = {
	reflection: true,
	aside: false,
	code: true,
	exercise: true,
	attempt: false,
	verdict: false,
};

/** Where an auto-filled cell came from. (chatId, toolCallId, role) is the
 *  idempotency key: re-running the fill never duplicates a cell. */
export interface JournalCellOrigin {
	chatId: string;
	toolCallId: string;
	/** The graph ideas the exercise targeted (may be empty). */
	ideaIds: string[];
}

export interface JournalCell {
	/** "cell_" + opaque suffix; unique within the journal. */
	id: string;
	role: JournalCellRole;
	/** Markdown (KaTeX `$…$` / `$$…$$` allowed) — or, for a code cell,
	 *  the program text. */
	source: string;
	/** Code cells: the highlight language ("python", "cpp", …). */
	lang?: string;
	/** Code cells: recorded output, pasted by the learner (v1 never runs code). */
	output?: string;
	publish: boolean;
	origin?: JournalCellOrigin;
	createdAt: string;
	updatedAt: string;
}

/** One successful publish of this journal. */
export interface JournalPublication {
	at: string;
	/** Absolute path of the site repo clone written into. */
	siteRepo: string;
	/** Bundle directory, relative to the site repo ("content/posts/2026-11-15-slug"). */
	path: string;
	/** The public URL, when the site's base URL is configured. */
	url?: string;
	/** The commit that carried it. */
	commit?: string;
}

export interface Journal {
	/** "jrnl_" + opaque suffix. */
	id: string;
	title: string;
	/** URL-safe; the bundle directory is `<date>-<slug>`. */
	slug: string;
	/** The session this journal belongs to; absent for a standalone journal. */
	chatId?: string;
	/** Extra post tags (idea names from exercises are added at export). */
	tags: string[];
	cells: JournalCell[];
	publications: JournalPublication[];
	createdAt: string;
	updatedAt: string;
}

/** The list view (sidebar / MCP journal_list). */
export interface JournalSummary {
	id: string;
	title: string;
	slug: string;
	chatId?: string;
	cellCount: number;
	publishedCellCount: number;
	lastPublishedAt?: string;
	updatedAt: string;
}

// ─── Publishing (phase 4) — shared by src/server/publish.ts and the pane ──

export interface PublishTarget {
	siteRepo: string;
	contentDir: string;
	format: JournalExportFormat;
	baseUrl?: string;
	push: boolean;
}

export type PlannedFileStatus = "new" | "changed" | "unchanged" | "removed";

/** The dry run: what a publish would write where, and what blocks it. */
export interface PublishPlan {
	journalId: string;
	/** null = publishing not set up (the plan still previews the bundle
	 *  against the default content folder). */
	target: PublishTarget | null;
	/** Bundle directory relative to the site repo, e.g. "content/posts/2026-11-15-slug". */
	dir: string | null;
	files: { name: string; status: PlannedFileStatus; content?: string }[];
	republish: boolean;
	branch: string | null;
	remote: string | null;
	commitMessage: string;
	url?: string;
	/** Anything here means Publish is refused; each is a user-facing sentence. */
	blockers: string[];
}

/** D7 outcome: "started" = published reflections handed to notes import;
 *  otherwise why not. */
export type GraphImportOutcome = "started" | "unchanged" | "graph-off" | "models-missing" | "nothing" | "test";

export interface PublishResult {
	journal: Journal;
	dir: string;
	/** False when every file was already identical (nothing committed, nothing recorded). */
	changed: boolean;
	commit?: string;
	pushed: boolean;
	url?: string;
	graphImport: GraphImportOutcome;
}

/** Bundle formats (owner, 2026-11-15, D5). `markdown`: index.md carries
 *  front matter + the body — portable to any static site generator.
 *  `notebook`: index.md carries front matter only and notebook.ipynb is
 *  the post (rhizoMorphic's convention). */
export const JOURNAL_EXPORT_FORMATS = ["markdown", "notebook"] as const;
export type JournalExportFormat = (typeof JOURNAL_EXPORT_FORMATS)[number];
