/**
 * Search everything (owner, 2026-11-15 — Mod+K): every journal's title,
 * tags, cell text, code and outputs. Pure: journals in, ranked hits out.
 * Every whitespace-separated term must appear (case-insensitive) in the hit's
 * text; titles rank above cells, earlier matches above later ones.
 */

import type { Journal, JournalCellRole } from "./contracts/journal.ts";

export interface JournalSearchHit {
	journalId: string;
	journalTitle: string;
	/** Absent = the journal itself matched (title / tags). */
	cellId?: string;
	role?: JournalCellRole;
	/** ~120 characters around the first match. */
	snippet: string;
}

function terms(query: string): string[] {
	return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function snippet(text: string, term: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const i = flat.toLowerCase().indexOf(term);
	if (i < 0 || flat.length <= 120) return flat.slice(0, 120);
	const start = Math.max(0, i - 40);
	return `${start > 0 ? "…" : ""}${flat.slice(start, start + 120)}${start + 120 < flat.length ? "…" : ""}`;
}

export function searchJournals(journals: readonly Journal[], query: string, limit = 50): JournalSearchHit[] {
	const ts = terms(query);
	if (ts.length === 0) return [];
	const matches = (text: string) => {
		const lower = text.toLowerCase();
		return ts.every((t) => lower.includes(t));
	};
	const titles: JournalSearchHit[] = [];
	const cells: JournalSearchHit[] = [];
	for (const j of journals) {
		const head = `${j.title} ${j.tags.join(" ")}`;
		if (matches(head)) titles.push({ journalId: j.id, journalTitle: j.title, snippet: j.tags.length ? j.tags.join(", ") : "" });
		for (const c of j.cells) {
			const text = [c.source, c.output ?? ""].join("\n");
			if (!matches(text)) continue;
			cells.push({ journalId: j.id, journalTitle: j.title, cellId: c.id, role: c.role, snippet: snippet(text, ts[0]!) });
		}
	}
	return [...titles, ...cells].slice(0, limit);
}
