/**
 * Journal service seam (learn-in-public, docs/learn-in-public.md). Id
 * minting and the session auto-fill live here; the pure transforms are in
 * core/journal.ts and core/journal-fill.ts, persistence behind the
 * JournalStore port.
 */

import { randomUUID } from "node:crypto";
import { isProblemSessionKind } from "../core/contracts.ts";
import {
	JournalError,
	appendCell,
	moveCell,
	newJournal,
	removeCell,
	updateCell,
	updateJournalMeta,
	upsertOriginCell,
	type CellPatch,
	type JournalMetaPatch,
	type NewCellInit,
} from "../core/journal.ts";
import { sessionJournalDrafts } from "../core/journal-fill.ts";
import type { Journal } from "../core/contracts/journal.ts";
import type { ChatStore, JournalStore } from "../core/ports.ts";
import { stores } from "./stores.ts";

export function newJournalId(): string {
	return `jrnl_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function newCellId(): string {
	return `cell_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Upsert the session-derived cells of a practice / improvise chat into its
 * journal, creating the journal on the first exercise. Teaching chats are
 * skipped (their journal is written by hand). Returns the journal when
 * anything was added, else null. Idempotent — safe to call every turn.
 */
export function fillJournalFromChat(
	deps: { chatStore: ChatStore; journalStore: JournalStore },
	chatId: string,
	now: string = new Date().toISOString(),
): Journal | null {
	const record = deps.chatStore.getChat(chatId);
	if (!record || !isProblemSessionKind(record.kind)) return null;
	// The learner deleted this session's journal: stay deleted (owner, 2026-11-15).
	if (deps.journalStore.isChatOptedOut(chatId)) return null;
	const drafts = sessionJournalDrafts(chatId, record.messages);
	if (drafts.length === 0) return null;

	const existing = deps.journalStore.findJournalByChat(chatId);
	let journal = existing ?? newJournal({ id: newJournalId(), title: record.title, chatId, now });
	let added = 0;
	for (const draft of drafts) {
		const r = upsertOriginCell(journal, { id: newCellId(), ...draft }, now);
		journal = r.journal;
		if (r.added) added++;
	}
	if (added === 0) return null;
	return existing ? deps.journalStore.saveJournal(journal) : deps.journalStore.createJournal(journal);
}

// ─── Operations (routes + MCP share these) ──────────────────────────────────
// LOST-UPDATE LAW (2026-11-15): the store is replace-whole and three
// writers touch a journal — the pane, the turn-end fill, MCP. So no caller
// ever sends a whole Journal: each operation reads FRESH, applies ONE pure
// transform, and saves, with no await in between (atomic on the event
// loop). Cell patches may carry the cell's updatedAt as a precondition; a
// stale edit gets a conflict instead of silently winning.

function mutate(id: string, op: (journal: Journal, now: string) => Journal): Journal {
	const journal = stores.journalStore.getJournal(id);
	if (!journal) throw new JournalError(`No journal [${id}].`, "not_found");
	return stores.journalStore.saveJournal(op(journal, new Date().toISOString()));
}

export function requireJournal(id: string): Journal {
	const journal = stores.journalStore.getJournal(id);
	if (!journal) throw new JournalError(`No journal [${id}].`, "not_found");
	return journal;
}

export function createJournal(init: { title: string; chatId?: string; slug?: string; tags?: string[] }): Journal {
	if (init.chatId !== undefined) {
		if (!stores.chatStore.getChat(init.chatId)) throw new JournalError(`No session [${init.chatId}].`, "not_found");
		if (stores.journalStore.findJournalByChat(init.chatId)) {
			throw new JournalError("This session already has a journal.", "conflict");
		}
	}
	const journal = newJournal({ id: newJournalId(), now: new Date().toISOString(), ...init });
	const created = stores.journalStore.createJournal(journal);
	if (init.chatId !== undefined) stores.journalStore.clearChatOptOut(init.chatId);
	return created;
}

export function patchJournalMeta(id: string, patch: JournalMetaPatch): Journal {
	return mutate(id, (j, now) => updateJournalMeta(j, patch, now));
}

export function addJournalCell(id: string, init: Omit<NewCellInit, "id" | "origin">, afterId?: string): Journal {
	return mutate(id, (j, now) => appendCell(j, { ...init, id: newCellId() }, now, afterId));
}

export function patchJournalCell(id: string, cellId: string, patch: CellPatch, ifUpdatedAt?: string): Journal {
	return mutate(id, (j, now) => {
		const cell = j.cells.find((c) => c.id === cellId);
		if (cell && ifUpdatedAt !== undefined && cell.updatedAt !== ifUpdatedAt) {
			throw new JournalError("This cell changed since you loaded it — reload and retry.", "conflict");
		}
		return updateCell(j, cellId, patch, now);
	});
}

export function deleteJournalCell(id: string, cellId: string): Journal {
	return mutate(id, (j, now) => removeCell(j, cellId, now));
}

export function moveJournalCell(id: string, cellId: string, toIndex: number): Journal {
	return mutate(id, (j, now) => moveCell(j, cellId, toIndex, now));
}

export function deleteJournal(id: string): boolean {
	return stores.journalStore.deleteJournal(id);
}

/** JournalError → HTTP status (routes). */
export function journalErrorStatus(err: JournalError): 400 | 404 | 409 {
	return err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400;
}

// ─── Request-body parsing (routes) ──────────────────────────────────────────
// Untrusted JSON in, typed op arguments out; anything malformed is a
// JournalError("invalid") → 400. Unknown keys are ignored.

type Body = Record<string, unknown>;

function optString(body: Body, key: string): string | undefined {
	const v = body[key];
	if (v === undefined) return undefined;
	if (typeof v !== "string") throw new JournalError(`${key} must be a string`, "invalid");
	return v;
}

function optBool(body: Body, key: string): boolean | undefined {
	const v = body[key];
	if (v === undefined) return undefined;
	if (typeof v !== "boolean") throw new JournalError(`${key} must be a boolean`, "invalid");
	return v;
}

function optStrings(body: Body, key: string): string[] | undefined {
	const v = body[key];
	if (v === undefined) return undefined;
	if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new JournalError(`${key} must be a string array`, "invalid");
	return v as string[];
}

export function asBody(raw: unknown): Body {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new JournalError("Body must be a JSON object.", "invalid");
	return raw as Body;
}

export function parseCreateJournal(body: Body): { title: string; chatId?: string; slug?: string; tags?: string[] } {
	const title = optString(body, "title") ?? "";
	const chatId = optString(body, "chatId");
	const slug = optString(body, "slug");
	const tags = optStrings(body, "tags");
	return { title, ...(chatId !== undefined ? { chatId } : {}), ...(slug !== undefined ? { slug } : {}), ...(tags ? { tags } : {}) };
}

export function parseMetaPatch(body: Body): JournalMetaPatch {
	const title = optString(body, "title");
	const slug = optString(body, "slug");
	const tags = optStrings(body, "tags");
	return { ...(title !== undefined ? { title } : {}), ...(slug !== undefined ? { slug } : {}), ...(tags ? { tags } : {}) };
}

export function parseNewCell(body: Body): { init: Omit<NewCellInit, "id" | "origin">; afterId?: string } {
	const role = optString(body, "role");
	if (role === undefined) throw new JournalError("role is required", "invalid");
	const source = optString(body, "source") ?? "";
	const lang = optString(body, "lang");
	const output = optString(body, "output");
	const publish = optBool(body, "publish");
	const afterId = optString(body, "afterId");
	return {
		init: {
			role: role as NewCellInit["role"],
			source,
			...(lang !== undefined ? { lang } : {}),
			...(output !== undefined ? { output } : {}),
			...(publish !== undefined ? { publish } : {}),
		},
		...(afterId !== undefined ? { afterId } : {}),
	};
}

export function parseCellPatch(body: Body): { patch: CellPatch; ifUpdatedAt?: string } {
	const patch: CellPatch = {};
	const role = optString(body, "role");
	if (role !== undefined) patch.role = role as CellPatch["role"];
	for (const key of ["source", "lang", "output"] as const) {
		const v = optString(body, key);
		if (v !== undefined) patch[key] = v;
	}
	const publish = optBool(body, "publish");
	if (publish !== undefined) patch.publish = publish;
	const ifUpdatedAt = optString(body, "ifUpdatedAt");
	return { patch, ...(ifUpdatedAt !== undefined ? { ifUpdatedAt } : {}) };
}

/** Run a route body; JournalError → its status, anything else → 500. */
export async function journalRoute(fn: () => Response | Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof JournalError) return Response.json({ error: err.message, code: err.code }, { status: journalErrorStatus(err) });
		if (err instanceof SyntaxError) return Response.json({ error: "Body must be JSON.", code: "invalid" }, { status: 400 });
		console.error("[journals] route failed:", err);
		return Response.json({ error: "Journal operation failed." }, { status: 500 });
	}
}
