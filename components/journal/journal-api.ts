/**
 * Client transport for /api/journals (learn-in-public). One function per
 * server operation — the lost-update law: the client never sends a whole
 * journal, only the one change. Every mutation returns the fresh journal.
 */

import type { CellPatch, InlineAskInput, UnderstandingCheck, UnderstandingLevel, Journal, JournalCell, JournalCellRole, JournalMetaPatch, JournalSummary, PublishPlan, PublishResult } from "@/src/core";

export type { PublishPlan, PublishResult };

/** One code-cell run (server: src/server/code-runner.ts RunResult). */
export interface CellRun {
	output: string;
	ok: boolean;
	executionCount: number;
	ms: number;
}

export class JournalApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
		this.name = "JournalApiError";
	}
}

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method,
		cache: "no-store",
		...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
	if (!res.ok) throw new JournalApiError(data.error ?? `Request failed (${res.status})`, res.status, data.code);
	return data as T;
}

type One = { journal: Journal };

/** POST, then read a text/plain stream; `onText` gets the text so far. */
async function streamText(url: string, body: unknown, onText: (soFar: string) => void, signal?: AbortSignal): Promise<string> {
	const res = await fetch(url, {
		method: "POST",
		cache: "no-store",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok || !res.body) {
		const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
		throw new JournalApiError(data.error ?? `Request failed (${res.status})`, res.status, data.code);
	}
	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let text = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		text += value;
		onText(text);
	}
	return text;
}
const base = "/api/journals";
const cellUrl = (id: string, cellId: string) => `${base}/${id}/cells/${cellId}`;

export const journalApi = {
	list: async () => (await call<{ journals: JournalSummary[] }>(base)).journals,
	byChat: async (chatId: string) => (await call<{ journal: Journal | null }>(`${base}?chatId=${encodeURIComponent(chatId)}`)).journal,
	get: async (id: string) => (await call<One>(`${base}/${id}`)).journal,
	create: async (init: { title: string; chatId?: string }) => (await call<One>(base, "POST", init)).journal,
	patchMeta: async (id: string, patch: JournalMetaPatch) => (await call<One>(`${base}/${id}`, "PATCH", patch)).journal,
	remove: async (id: string) => call<{ ok: true }>(`${base}/${id}`, "DELETE"),
	addCell: async (id: string, init: { role: JournalCellRole; source?: string; lang?: string }, afterId?: string) =>
		(await call<One>(`${base}/${id}/cells`, "POST", { ...init, ...(afterId ? { afterId } : {}) })).journal,
	patchCell: async (id: string, cellId: string, patch: CellPatch, ifUpdatedAt?: string) =>
		(await call<One>(cellUrl(id, cellId), "PATCH", { ...patch, ...(ifUpdatedAt ? { ifUpdatedAt } : {}) })).journal,
	moveCell: async (id: string, cellId: string, toIndex: number) => (await call<One>(cellUrl(id, cellId), "PATCH", { toIndex })).journal,
	restoreCell: async (id: string, cell: JournalCell, index: number) => (await call<One>(`${base}/${id}/cells`, "POST", { restore: cell, index })).journal,
	deleteCell: async (id: string, cellId: string) => (await call<One>(cellUrl(id, cellId), "DELETE")).journal,
	/** Run a code cell; the journal comes back with the cell's output + run number. */
	runCell: async (id: string, cellId: string) => call<{ journal: Journal; run: CellRun }>(`${cellUrl(id, cellId)}/run`, "POST"),
	restartKernel: async (id: string) => call<{ ok: true }>(`${base}/${id}/kernel`, "DELETE"),
	/** Stream an answer about one cell; the server saves it as an aside when done. */
	askCell: (id: string, cellId: string, question: string, onText: (soFar: string) => void, signal?: AbortSignal) =>
		streamText(`${cellUrl(id, cellId)}/ask`, { question }, onText, signal),
	/** Inline ask while editing (ephemeral): explain / insert / ask about a selection. */
	inlineAsk: (id: string, cellId: string, body: InlineAskInput, onText: (soFar: string) => void, signal?: AbortSignal) =>
		streamText(`${cellUrl(id, cellId)}/inline`, body, onText, signal),
	/** Run an agent cell; the server saves the answer as the cell's output when done. */
	runAgent: (id: string, cellId: string, onText: (soFar: string) => void, signal?: AbortSignal) =>
		streamText(`${cellUrl(id, cellId)}/agent`, {}, onText, signal),
	/** Upload one image / video (streamed raw) → the markdown that embeds it. */
	uploadMedia: async (id: string, file: File) => {
		const res = await fetch(`${base}/${id}/media`, {
			method: "POST",
			cache: "no-store",
			headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
			body: file,
		});
		const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; name?: string; markdown?: string };
		if (!res.ok || !data.markdown) throw new JournalApiError(data.error ?? `Upload failed (${res.status})`, res.status, data.code);
		return { name: data.name!, markdown: data.markdown };
	},
	/** Rate a cell (null clears); "stuck" returns the prerequisites agent cell to run. */
	rateCell: async (id: string, cellId: string, level: UnderstandingLevel | null) =>
		call<{ journal: Journal; prereqCellId?: string }>(`${cellUrl(id, cellId)}/rate`, "POST", { level }),
	/** Read this cell into the graph now (edited text replaces its earlier contribution). */
	extractCell: async (id: string, cellId: string) =>
		call<{ journal: Journal; outcome: string; stats?: { nodes: number; chains?: number } }>(`${cellUrl(id, cellId)}/extract`, "POST"),
	checkQuestion: (id: string, cellId: string, onText: (soFar: string) => void, signal?: AbortSignal) =>
		streamText(`${cellUrl(id, cellId)}/check`, { phase: "question" }, onText, signal),
	checkGrade: async (id: string, cellId: string, question: string, answer: string) =>
		call<{ journal: Journal; check: UnderstandingCheck }>(`${cellUrl(id, cellId)}/check`, "POST", { phase: "grade", question, answer }),
	plan: async (id: string) => (await call<{ plan: PublishPlan }>(`${base}/${id}/publish`)).plan,
	publish: async (id: string, confirmDir: string) => (await call<{ result: PublishResult }>(`${base}/${id}/publish`, "POST", { confirmDir })).result,
};

/**
 * A new notebook = one empty markdown cell (owner, 2026-11-15: a plain text
 * note is just a notebook with a single markdown entry). Opens it; the view
 * starts editing that lone empty cell.
 */
export async function createNotebook(router: { push: (href: string) => void }, title = "Untitled notebook"): Promise<Journal> {
	const created = await journalApi.create({ title });
	const j = await journalApi.addCell(created.id, { role: "reflection" });
	router.push(`/notebook/${j.id}`);
	return j;
}
