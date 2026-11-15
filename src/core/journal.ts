/**
 * Journal operations — pure value transforms over the Journal record
 * (contracts/journal.ts). Every operation returns a NEW journal; the caller
 * persists it (JournalStore.saveJournal). Ids and the clock are passed in,
 * so this module needs no crypto and no Date of its own: browser-safe, and
 * deterministic under test.
 */

import type {
	Journal,
	JournalCell,
	JournalCellOrigin,
	JournalCellRole,
	JournalSummary,
} from "./contracts/journal.ts";
import { DEFAULT_PUBLISH, JOURNAL_CELL_ROLES } from "./contracts/journal.ts";

/** A refused operation (unknown cell, bad slug, …). The message is
 *  user-facing; routes map it to 400/404. */
export class JournalError extends Error {
	constructor(
		message: string,
		readonly code: "not_found" | "invalid" | "conflict",
	) {
		super(message);
		this.name = "JournalError";
	}
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Title → URL-safe slug: lowercase ASCII words joined by "-", at most 60
 *  chars, never empty ("journal" as the floor). */
export function slugify(title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug || "journal";
}

export function isValidSlug(slug: string): boolean {
	return SLUG_RE.test(slug) && slug.length <= 80;
}

export function isJournalCellRole(role: unknown): role is JournalCellRole {
	return typeof role === "string" && (JOURNAL_CELL_ROLES as readonly string[]).includes(role);
}

export interface NewJournalInit {
	id: string;
	title: string;
	chatId?: string;
	slug?: string;
	tags?: string[];
	now: string;
}

export function newJournal(init: NewJournalInit): Journal {
	const title = init.title.trim() || "Untitled journal";
	const slug = init.slug ?? slugify(title);
	if (!isValidSlug(slug)) throw new JournalError(`Invalid slug "${slug}" — use lowercase words joined by "-".`, "invalid");
	return {
		id: init.id,
		title,
		slug,
		...(init.chatId !== undefined ? { chatId: init.chatId } : {}),
		tags: init.tags ?? [],
		cells: [],
		publications: [],
		createdAt: init.now,
		updatedAt: init.now,
	};
}

export interface NewCellInit {
	id: string;
	role: JournalCellRole;
	source: string;
	lang?: string;
	output?: string;
	/** Omitted = the role's default (DEFAULT_PUBLISH). */
	publish?: boolean;
	origin?: JournalCellOrigin;
}

function buildCell(init: NewCellInit, now: string): JournalCell {
	if (!isJournalCellRole(init.role)) throw new JournalError(`Unknown cell role "${String(init.role)}".`, "invalid");
	return {
		id: init.id,
		role: init.role,
		source: init.source,
		...(init.lang ? { lang: init.lang } : {}),
		...(init.output ? { output: init.output } : {}),
		publish: init.publish ?? DEFAULT_PUBLISH[init.role],
		...(init.origin ? { origin: init.origin } : {}),
		createdAt: now,
		updatedAt: now,
	};
}

function indexOfCell(journal: Journal, cellId: string): number {
	const i = journal.cells.findIndex((c) => c.id === cellId);
	if (i < 0) throw new JournalError(`No cell [${cellId}] in journal [${journal.id}].`, "not_found");
	return i;
}

/** Insert a cell — after `afterId` when given, else at the end. */
export function appendCell(journal: Journal, init: NewCellInit, now: string, afterId?: string): Journal {
	if (journal.cells.some((c) => c.id === init.id)) throw new JournalError(`Cell id [${init.id}] already exists.`, "invalid");
	const cell = buildCell(init, now);
	const cells = [...journal.cells];
	const at = afterId === undefined ? cells.length : indexOfCell(journal, afterId) + 1;
	cells.splice(at, 0, cell);
	return { ...journal, cells, updatedAt: now };
}

/** The editable fields of a cell. `lang`/`output` set to "" (and
 *  `executionCount` set to 0) clear them. */
export type CellPatch = Partial<Pick<JournalCell, "role" | "source" | "lang" | "output" | "publish" | "executionCount">>;

export function updateCell(journal: Journal, cellId: string, patch: CellPatch, now: string): Journal {
	const i = indexOfCell(journal, cellId);
	if (patch.role !== undefined && !isJournalCellRole(patch.role)) {
		throw new JournalError(`Unknown cell role "${String(patch.role)}".`, "invalid");
	}
	const prev = journal.cells[i]!;
	const next: JournalCell = { ...prev, ...patch, updatedAt: now };
	if (!next.lang) delete next.lang;
	if (!next.output) delete next.output;
	if (next.executionCount === undefined || next.executionCount <= 0) delete next.executionCount;
	const cells = [...journal.cells];
	cells[i] = next;
	return { ...journal, cells, updatedAt: now };
}

export function removeCell(journal: Journal, cellId: string, now: string): Journal {
	const i = indexOfCell(journal, cellId);
	return { ...journal, cells: journal.cells.filter((_, j) => j !== i), updatedAt: now };
}

/** Move a cell to `toIndex` (clamped into range). */
export function moveCell(journal: Journal, cellId: string, toIndex: number, now: string): Journal {
	const from = indexOfCell(journal, cellId);
	const cells = [...journal.cells];
	const [cell] = cells.splice(from, 1);
	const to = Math.max(0, Math.min(cells.length, Math.trunc(toIndex)));
	cells.splice(to, 0, cell!);
	return { ...journal, cells, updatedAt: now };
}

/**
 * Put a whole cell back at `index` (clamped) — the notebook's undo of a
 * delete / redo of an add. Keeps its id, outputs and rating; drops `graph`
 * (deleting withdrew its ideas, so the cell is "not in the graph" again).
 */
export function restoreCell(journal: Journal, cell: JournalCell, index: number, now: string): Journal {
	if (!isJournalCellRole(cell.role)) throw new JournalError(`Unknown cell role "${String(cell.role)}".`, "invalid");
	if (journal.cells.some((c) => c.id === cell.id)) throw new JournalError(`Cell id [${cell.id}] already exists.`, "conflict");
	const { graph: _withdrawn, ...kept } = cell;
	const cells = [...journal.cells];
	cells.splice(Math.max(0, Math.min(cells.length, Math.trunc(index))), 0, { ...kept, updatedAt: now });
	return { ...journal, cells, updatedAt: now };
}

export interface JournalMetaPatch {
	title?: string;
	slug?: string;
	tags?: string[];
}

export function updateJournalMeta(journal: Journal, patch: JournalMetaPatch, now: string): Journal {
	const next = { ...journal, updatedAt: now };
	if (patch.title !== undefined) {
		const title = patch.title.trim();
		if (!title) throw new JournalError("A journal needs a title.", "invalid");
		next.title = title;
	}
	if (patch.slug !== undefined && patch.slug !== journal.slug) {
		// The bundle directory is pinned at first publish (republish reuses
		// it); a new slug would orphan the live post.
		if (journal.publications.length > 0) {
			throw new JournalError("This journal is already published — its slug is pinned to the live post.", "invalid");
		}
		if (!isValidSlug(patch.slug)) throw new JournalError(`Invalid slug "${patch.slug}" — use lowercase words joined by "-".`, "invalid");
		next.slug = patch.slug;
	}
	if (patch.tags !== undefined) next.tags = [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))];
	return next;
}

/** The auto-fill seam (phase 2): add a session-derived cell unless one
 *  with the same (chatId, toolCallId, role) already exists. An existing
 *  cell is left untouched — the learner may have edited it. */
export function upsertOriginCell(
	journal: Journal,
	init: NewCellInit & { origin: JournalCellOrigin },
	now: string,
): { journal: Journal; added: boolean } {
	const exists = journal.cells.some(
		(c) =>
			c.role === init.role &&
			c.origin?.chatId === init.origin.chatId &&
			c.origin.toolCallId === init.origin.toolCallId,
	);
	if (exists) return { journal, added: false };
	return { journal: appendCell(journal, init, now), added: true };
}

export function summarizeJournal(journal: Journal): JournalSummary {
	const last = journal.publications.at(-1);
	return {
		id: journal.id,
		title: journal.title,
		slug: journal.slug,
		...(journal.chatId !== undefined ? { chatId: journal.chatId } : {}),
		cellCount: journal.cells.length,
		publishedCellCount: journal.cells.filter((c) => c.publish).length,
		...(last ? { lastPublishedAt: last.at } : {}),
		updatedAt: journal.updatedAt,
	};
}
