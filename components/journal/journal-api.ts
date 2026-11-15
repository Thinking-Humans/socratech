/**
 * Client transport for /api/journals (learn-in-public). One function per
 * server operation — the lost-update law: the client never sends a whole
 * journal, only the one change. Every mutation returns the fresh journal.
 */

import type { CellPatch, Journal, JournalCellRole, JournalMetaPatch, JournalSummary, PublishPlan, PublishResult } from "@/src/core";

export type { PublishPlan, PublishResult };

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
	deleteCell: async (id: string, cellId: string) => (await call<One>(cellUrl(id, cellId), "DELETE")).journal,
	plan: async (id: string) => (await call<{ plan: PublishPlan }>(`${base}/${id}/publish`)).plan,
	publish: async (id: string, confirmDir: string) => (await call<{ result: PublishResult }>(`${base}/${id}/publish`, "POST", { confirmDir })).result,
};
