/**
 * Journal service seam (learn-in-public, docs/learn-in-public.md). Id
 * minting and the session auto-fill live here; the pure transforms are in
 * core/journal.ts and core/journal-fill.ts, persistence behind the
 * JournalStore port.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { isProblemSessionKind } from "../core/contracts.ts";
import {
	JournalError,
	isJournalCellRole,
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
import {
	INLINE_EXPLAIN_SYSTEM_PROMPT,
	INLINE_INSERT_SYSTEM_PROMPT,
	JOURNAL_AGENT_SYSTEM_PROMPT,
	JOURNAL_ASK_SYSTEM_PROMPT,
	askAnswerCell,
	inlineAskPrompt,
	journalAgentPrompt,
	journalAskPrompt,
	runnableLang,
	type InlineAskInput,
} from "../core/journal-code.ts";
import type { CellGraphState, CellUnderstanding, Journal } from "../core/contracts/journal.ts";
import { searchJournals, type JournalSearchHit } from "../core/journal-search.ts";
import type { ChatStore, JournalStore } from "../core/ports.ts";
import { restartKernel, runCode, type RunResult } from "./code-runner.ts";
import { NoteError } from "./notes.ts";
import { strongTextStream } from "./notes-ask.ts";
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
	const deleted = stores.journalStore.deleteJournal(id);
	if (deleted) {
		// Its Python kernel and uploaded media go with it (files its code wrote
		// under journal-work/ stay — they may be the learner's).
		restartKernel(id);
		fs.rmSync(path.join(PATHS.data, "journal-media", id.replace(/[^\w-]/g, "_")), { recursive: true, force: true });
	}
	return deleted;
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

// ─── Running code + cell /ask (owner, 2026-11-15 — reverses D8) ─────────────

/**
 * Run a code cell in its journal's session and record the output + run
 * number on the cell. Reads the cell fresh (what was saved is what runs);
 * the output lands through ONE patch on a fresh read after the run.
 */
export async function runJournalCell(id: string, cellId: string): Promise<{ journal: Journal; run: RunResult }> {
	const cell = requireJournal(id).cells.find((c) => c.id === cellId);
	if (!cell) throw new JournalError(`No cell [${cellId}] in journal [${id}].`, "not_found");
	if (cell.role !== "code") throw new JournalError("Only code cells run.", "invalid");
	const lang = runnableLang(cell.lang);
	if (!lang) throw new JournalError(`Can't run "${cell.lang || "text"}" — set the cell's language to python or cpp.`, "invalid");
	if (!cell.source.trim()) throw new JournalError("The cell is empty.", "invalid");
	const run = await runCode(id, lang, cell.source);
	const journal = patchJournalCell(id, cellId, { output: run.output, executionCount: run.executionCount });
	return { journal, run };
}

/** Drop the journal's Python state; run numbers restart at 1. */
export function restartJournalKernel(id: string): void {
	requireJournal(id);
	restartKernel(id);
}

const ASK_ANSWER_PREFIX = "**/ask** ";

/**
 * Stream the strong model's answer to `question` about one cell (it sees
 * the whole cell — text, code, output — plus the cells around it). When
 * the answer is complete it is saved as a private aside right below the
 * cell (after earlier answers to that cell), even if the reader left.
 */
export function journalAskStream(id: string, cellId: string, question: string): ReadableStream<Uint8Array> {
	if (!question.trim()) throw new JournalError("The question is empty.", "invalid");
	const prompt = journalAskPrompt(requireJournal(id), cellId, question.trim());
	const save = (answer: string) => {
		const fresh = stores.journalStore.getJournal(id);
		if (!fresh) return;
		const at = fresh.cells.findIndex((c) => c.id === cellId);
		let afterId: string | undefined;
		if (at >= 0) {
			let last = at;
			while (fresh.cells[last + 1]?.role === "aside" && fresh.cells[last + 1]!.source.startsWith(ASK_ANSWER_PREFIX)) last++;
			afterId = fresh.cells[last]!.id;
		}
		addJournalCell(id, { role: "aside", source: askAnswerCell(question.trim(), answer) }, afterId);
	};
	try {
		return strongTextStream(JOURNAL_ASK_SYSTEM_PROMPT, prompt, "journal-ask", undefined, save);
	} catch (err) {
		if (err instanceof NoteError) throw new JournalError(err.message, "invalid");
		throw err;
	}
}

/**
 * Run an agent cell: stream the strong model's answer to the cell's request
 * (whole journal as context). The finished answer becomes the cell's output
 * — one patch on a fresh read — even if the reader left.
 */
export function journalAgentStream(id: string, cellId: string): ReadableStream<Uint8Array> {
	const journal = requireJournal(id);
	const cell = journal.cells.find((c) => c.id === cellId);
	if (!cell) throw new JournalError(`No cell [${cellId}] in journal [${id}].`, "not_found");
	if (cell.role !== "agent") throw new JournalError("Only agent cells run the agent.", "invalid");
	if (!cell.source.trim()) throw new JournalError("The agent cell is empty — write a request first.", "invalid");
	const prompt = journalAgentPrompt(journal, cellId);
	try {
		return strongTextStream(JOURNAL_AGENT_SYSTEM_PROMPT, prompt, "journal-agent", undefined, (answer) => {
			patchJournalCell(id, cellId, { output: answer.trim() });
		});
	} catch (err) {
		if (err instanceof NoteError) throw new JournalError(err.message, "invalid");
		throw err;
	}
}

/** Mod+K: every journal, ranked hits (src/core/journal-search.ts). */
export function searchAllJournals(query: string): JournalSearchHit[] {
	const journals = stores.journalStore
		.listJournals()
		.map((s) => stores.journalStore.getJournal(s.id))
		.filter((j): j is Journal => j !== null && j !== undefined);
	return searchJournals(journals, query);
}

/** Inline ask while editing: stream an explanation / insert text about the
 *  highlighted passage. Ephemeral — nothing is saved. */
export function journalInlineStream(id: string, cellId: string, input: InlineAskInput, signal?: AbortSignal): ReadableStream<Uint8Array> {
	const prompt = inlineAskPrompt(requireJournal(id), cellId, input);
	const system = input.mode === "insert" ? INLINE_INSERT_SYSTEM_PROMPT : INLINE_EXPLAIN_SYSTEM_PROMPT;
	try {
		return strongTextStream(system, prompt, "notebook-inline", signal);
	} catch (err) {
		if (err instanceof NoteError) throw new JournalError(err.message, "invalid");
		throw err;
	}
}

/** Untrusted body → InlineAskInput (route). */
export function parseInlineAsk(body: Record<string, unknown>): InlineAskInput {
	const mode = body.mode;
	if (mode !== "explain" && mode !== "insert" && mode !== "ask") throw new JournalError("mode must be explain, insert or ask", "invalid");
	const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
	const turns = Array.isArray(body.turns)
		? (body.turns as unknown[]).flatMap((t) => {
				const r = t as { role?: unknown; text?: unknown };
				return (r.role === "user" || r.role === "assistant") && typeof r.text === "string" ? [{ role: r.role as "user" | "assistant", text: r.text }] : [];
			})
		: [];
	const role = str("role");
	if (!isJournalCellRole(role)) throw new JournalError("role is invalid", "invalid");
	return { mode, draft: str("draft"), role, ...(str("lang") ? { lang: str("lang") } : {}), selection: str("selection"), turns: turns.slice(-12) };
}

// ─── Learning fields + insert-before (notebook-learning.ts uses these) ──────

/** Set / clear a cell's rating or graph state — one op on a fresh read. */
export function setCellLearning(
	id: string,
	cellId: string,
	fields: { understanding?: CellUnderstanding | null; graph?: CellGraphState | null },
): Journal {
	return mutate(id, (j, now) => {
		const i = j.cells.findIndex((c) => c.id === cellId);
		if (i < 0) throw new JournalError(`No cell [${cellId}] in journal [${id}].`, "not_found");
		const next = { ...j.cells[i]! };
		for (const key of ["understanding", "graph"] as const) {
			if (!(key in fields)) continue;
			const v = fields[key];
			if (v === null) delete next[key];
			else (next as Record<string, unknown>)[key] = v;
		}
		const cells = [...j.cells];
		cells[i] = next;
		// Learning metadata is not an edit: the cell's updatedAt stays.
		return { ...j, cells, updatedAt: now };
	});
}

/** Insert a new cell directly ABOVE `beforeId` → the journal + the new cell's id. */
export function insertCellBefore(id: string, beforeId: string, init: Omit<NewCellInit, "id" | "origin">): { journal: Journal; cellId: string } {
	const cellId = newCellId();
	const journal = mutate(id, (j, now) => {
		const at = j.cells.findIndex((c) => c.id === beforeId);
		if (at < 0) throw new JournalError(`No cell [${beforeId}] in journal [${id}].`, "not_found");
		const appended = at === 0 ? appendCell(j, { ...init, id: cellId }, now) : appendCell(j, { ...init, id: cellId }, now, j.cells[at - 1]!.id);
		return at === 0 ? moveCell(appended, cellId, 0, now) : appended;
	});
	return { journal, cellId };
}
