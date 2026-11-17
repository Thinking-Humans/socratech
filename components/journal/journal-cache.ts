/**
 * Notebooks this page has seen, by id — so switching back (Mod+O, Alt+1…9)
 * paints at once while the fresh copy loads. Memory only; the server stays
 * the truth and every open revalidates.
 */

import type { Journal } from "@/src/core";
import { journalApi } from "@/components/journal/journal-api";

const cache = new Map<string, Journal>();
const warming = new Set<string>();

export const cachedJournal = (id: string): Journal | undefined => cache.get(id);

export function rememberJournal(journal: Journal): void {
	cache.set(journal.id, journal);
}

/** Fetch a notebook into the cache ahead of a likely switch (`refresh`: even if cached). */
export function warmJournal(id: string, refresh = false): void {
	if (warming.has(id) || (!refresh && cache.has(id))) return;
	warming.add(id);
	journalApi
		.get(id)
		.then((j) => cache.set(id, j))
		.catch(() => cache.delete(id))
		.finally(() => warming.delete(id));
}
