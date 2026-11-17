/**
 * The notebook switcher (Mod+O, owner 2026-11-17): telescope-style list of
 * notebooks with Harpoon-style pinned slots (Alt+1 … Alt+9 jump straight to
 * one). Pure ordering + slot/recent bookkeeping; the component persists the
 * two lists on this device.
 */

import { fuzzyScore } from "./fuzzy.ts";

export const NOTEBOOK_SLOT_COUNT = 9;
/** Slot index (0-based) → notebook id, or null when the slot is free. */
export type NotebookSlots = readonly (string | null)[];
const RECENT_LIMIT = 50;

/** Untrusted (localStorage) → exactly NOTEBOOK_SLOT_COUNT entries, each id at most once. */
export function normalizeSlots(raw: unknown): NotebookSlots {
	const seen = new Set<string>();
	const list = Array.isArray(raw) ? raw : [];
	return Array.from({ length: NOTEBOOK_SLOT_COUNT }, (_, i) => {
		const id = list[i];
		if (typeof id !== "string" || !id || seen.has(id)) return null;
		seen.add(id);
		return id;
	});
}

/** Untrusted (localStorage) → notebook ids, most recently opened first. */
export function normalizeRecent(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.filter((id): id is string => typeof id === "string" && id !== ""))].slice(0, RECENT_LIMIT);
}

/**
 * Pin `id` to `slot` (0-based). Its own slot again unpins it; from another
 * slot it swaps with whatever sat there; otherwise it replaces the occupant.
 */
export function assignSlot(slots: NotebookSlots, slot: number, id: string): NotebookSlots {
	const next = [...normalizeSlots(slots)];
	if (slot < 0 || slot >= NOTEBOOK_SLOT_COUNT) return next;
	const from = next.indexOf(id);
	if (from === slot) {
		next[slot] = null;
		return next;
	}
	if (from >= 0) next[from] = next[slot] ?? null;
	next[slot] = id;
	return next;
}

/** `id` was just opened: it moves to the front. */
export function touchRecent(recent: readonly string[], id: string): string[] {
	return [id, ...recent.filter((r) => r !== id)].slice(0, RECENT_LIMIT);
}

export interface SwitcherRow<T> {
	item: T;
	/** 1-based pinned slot, when pinned. */
	slot?: number;
	current: boolean;
}

/**
 * The switcher's rows and the row to preselect.
 * No query: pinned notebooks by slot, then recently opened (newest first),
 * then the rest in the given order (the server's: newest activity first).
 * The preselected row is the notebook opened just before the current one,
 * so open → Enter flips between two notebooks.
 * With a query: fuzzy title matches, best first; the top one is preselected.
 */
export function orderNotebooks<T extends { id: string; title: string }>(
	items: readonly T[],
	opts: { slots: NotebookSlots; recent: readonly string[]; currentId?: string; query?: string },
): { rows: SwitcherRow<T>[]; selected: number } {
	const slotOf = new Map<string, number>();
	normalizeSlots(opts.slots).forEach((id, i) => id && slotOf.set(id, i + 1));
	const row = (item: T): SwitcherRow<T> => {
		const slot = slotOf.get(item.id);
		return { item, ...(slot ? { slot } : {}), current: item.id === opts.currentId };
	};
	const query = opts.query?.trim() ?? "";
	if (query) {
		const scored = items.flatMap((item) => {
			const score = fuzzyScore(query, item.title);
			return score === null ? [] : [{ item, score }];
		});
		scored.sort((a, b) => b.score - a.score);
		return { rows: scored.map((s) => row(s.item)), selected: 0 };
	}
	const rank = new Map(opts.recent.map((id, i) => [id, i]));
	const pinned = items.filter((i) => slotOf.has(i.id)).sort((a, b) => slotOf.get(a.id)! - slotOf.get(b.id)!);
	const unpinned = items.filter((i) => !slotOf.has(i.id));
	const recent = unpinned.filter((i) => rank.has(i.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
	const rest = unpinned.filter((i) => !rank.has(i.id));
	const rows = [...pinned, ...recent, ...rest].map(row);
	const known = new Set(items.map((i) => i.id));
	const previous = opts.recent.find((id) => id !== opts.currentId && known.has(id));
	const at = previous ? rows.findIndex((r) => r.item.id === previous) : rows.findIndex((r) => !r.current);
	return { rows, selected: Math.max(0, at) };
}
