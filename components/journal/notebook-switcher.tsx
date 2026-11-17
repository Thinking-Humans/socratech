"use client";

/**
 * THE NOTEBOOK SWITCHER (Mod+O, owner 2026-11-17) — telescope for notebooks,
 * with Harpoon-style pinned slots. The list opens on the notebook you were
 * in last (Enter flips back); typing fuzzy-filters titles; ↑/↓ or Ctrl+J/K
 * walk; Mod+1…9 pins the highlighted notebook to that slot; Alt+1…9 jumps to
 * a slot from anywhere without opening the list.
 *
 * Built for speed: the notebook list is kept loaded (never fetched on open),
 * likely targets are prefetched — route and notebook — and an opened
 * notebook paints from memory (journal-cache.ts).
 * Recents and slots live on this device (localStorage).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { NotebookPenIcon } from "lucide-react";
import {
	NOTEBOOK_SLOT_NUMBERS,
	assignSlot,
	bindingForAction,
	eventBinding,
	eventMatchesAction,
	formatBinding,
	normalizeRecent,
	normalizeSlots,
	orderNotebooks,
	touchRecent,
	type JournalSummary,
	type NotebookSlots,
} from "@/src/core";
import { HostDialog } from "@/components/host-dialog";
import { useNotifyHub } from "@/components/server-events";
import { journalApi } from "@/components/journal/journal-api";
import { cachedJournal, warmJournal } from "@/components/journal/journal-cache";
import { cn } from "@/lib/utils";

const SLOTS_KEY = "lh:notebook-slots";
const RECENT_KEY = "lh:notebook-recent";
/** How many recently opened notebooks are kept warm besides the pinned ones. */
const WARM_RECENT = 4;

function readList(key: string): unknown {
	try {
		return JSON.parse(window.localStorage.getItem(key) ?? "null");
	} catch {
		return null;
	}
}

function writeList(key: string, value: unknown): void {
	try {
		window.localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* storage unavailable: the lists last for this page only */
	}
}

const notebookPath = (id: string) => `/notebook/${id}`;
const currentNotebook = (pathname: string | null) => /^\/notebook\/([^/]+)$/.exec(pathname ?? "")?.[1];

/**
 * The switcher's state, alive for the whole app (it also serves the Alt+N
 * jumps while the list is closed): the notebook list, recents and slots.
 */
export function useNotebookNav() {
	const router = useRouter();
	const pathname = usePathname();
	const hub = useNotifyHub();
	const currentId = currentNotebook(pathname);
	const [journals, setJournals] = useState<JournalSummary[]>([]);
	const [slots, setSlots] = useState<NotebookSlots>(() => normalizeSlots(null));
	const [recent, setRecent] = useState<string[]>([]);

	const load = useCallback(() => {
		journalApi
			.list()
			.then(setJournals)
			.catch(() => undefined);
	}, []);

	useEffect(() => {
		setSlots(normalizeSlots(readList(SLOTS_KEY)));
		setRecent(normalizeRecent(readList(RECENT_KEY)));
		load();
	}, [load]);

	// Stay current without ever fetching on open; a notebook someone else
	// changed is re-read if it was warm.
	useEffect(() => {
		if (!hub) return;
		const off = hub.subscribe("journals-changed", (e) => {
			load();
			if (e.journalId !== currentNotebook(window.location.pathname) && cachedJournal(e.journalId)) warmJournal(e.journalId, true);
		});
		return () => {
			off();
		};
	}, [hub, load]);

	// Opening a notebook moves it to the front of the recents.
	useEffect(() => {
		if (!currentId) return;
		setRecent((prev) => {
			if (prev[0] === currentId) return prev;
			const next = touchRecent(normalizeRecent(readList(RECENT_KEY)), currentId);
			writeList(RECENT_KEY, next);
			return next;
		});
	}, [currentId]);

	// Keep the likely targets one keystroke away: route + notebook in memory.
	const known = useMemo(() => new Set(journals.map((j) => j.id)), [journals]);
	useEffect(() => {
		const targets = [...slots.filter((id): id is string => id !== null), ...recent.slice(0, WARM_RECENT + 1)];
		for (const id of new Set(targets)) {
			if (id === currentId || !known.has(id)) continue;
			router.prefetch(notebookPath(id));
			warmJournal(id);
		}
	}, [slots, recent, known, currentId, router]);

	const open = useCallback(
		(id: string) => {
			if (id !== currentNotebook(window.location.pathname)) router.push(notebookPath(id));
		},
		[router],
	);

	/** Alt+N: jump to the notebook pinned to slot `n` (1-based). False when the slot is free. */
	const openSlot = useCallback(
		(n: number): boolean => {
			const id = normalizeSlots(readList(SLOTS_KEY))[n - 1];
			if (!id) return false;
			open(id);
			return true;
		},
		[open],
	);

	const pin = useCallback((n: number, id: string) => {
		setSlots(() => {
			const next = assignSlot(normalizeSlots(readList(SLOTS_KEY)), n - 1, id);
			writeList(SLOTS_KEY, next);
			return next;
		});
	}, []);

	return { journals, slots, recent, currentId, open, openSlot, pin };
}

export type NotebookNav = ReturnType<typeof useNotebookNav>;

export function NotebookSwitcher({ open, onClose, nav }: { open: boolean; onClose: () => void; nav: NotebookNav }) {
	const headingId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState("");
	/** The walked row, by notebook id (null = the preselected one). */
	const [walked, setWalked] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setWalked(null);
	}, [open]);

	const { rows, selected } = useMemo(
		() => orderNotebooks(nav.journals, { slots: nav.slots, recent: nav.recent, ...(nav.currentId ? { currentId: nav.currentId } : {}), query }),
		[nav.journals, nav.slots, nav.recent, nav.currentId, query],
	);
	const walkedAt = walked === null ? -1 : rows.findIndex((r) => r.item.id === walked);
	const index = walkedAt >= 0 ? walkedAt : selected;

	useEffect(() => {
		listRef.current?.querySelector(`[data-row="${index}"]`)?.scrollIntoView({ block: "nearest" });
	}, [index, open]);

	const go = (id: string | undefined) => {
		if (!id) return;
		onClose();
		nav.open(id);
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		const native = e.nativeEvent;
		const claim = () => {
			e.preventDefault();
			e.stopPropagation();
		};
		const step = e.key === "ArrowDown" || (e.ctrlKey && e.key.toLowerCase() === "j") ? 1 : e.key === "ArrowUp" || (e.ctrlKey && e.key.toLowerCase() === "k") ? -1 : 0;
		if (step) {
			claim();
			if (rows.length) setWalked(rows[(index + step + rows.length) % rows.length]!.item.id);
			return;
		}
		if (e.key === "Enter") {
			claim();
			go(rows[index]?.item.id);
			return;
		}
		for (const n of NOTEBOOK_SLOT_NUMBERS) {
			// Jump to a slot (the same chord as outside the list).
			if (eventMatchesAction(native, `notebook-slot-${n}`)) {
				claim();
				if (nav.openSlot(n)) onClose();
				return;
			}
			// Pin the highlighted notebook to slot n.
			if (eventBinding(native) === `mod+${n}`) {
				claim();
				const row = rows[index];
				if (row) {
					setWalked(row.item.id);
					nav.pin(n, row.item.id);
				}
				return;
			}
		}
	};

	const slotKeys = formatBinding(bindingForAction("notebook-slot-1")).replace(/1$/, "1–9");
	const pinKeys = formatBinding("mod+1").replace(/1$/, "1–9");

	return (
		<HostDialog
			open={open}
			onClose={() => {
				onClose();
				return "closed";
			}}
			aria-labelledby={headingId}
			initialFocusRef={inputRef}
			backdropProps={{ "data-testid": "notebook-switcher", className: "fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" }}
			frame={<div className="flex max-h-[70vh] w-full max-w-[34rem] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()} />}
		>
			<span id={headingId} className="sr-only">
				Switch notebook
			</span>
			<div className="flex items-center gap-2 border-b border-border px-3 py-2">
				<NotebookPenIcon className="size-4 text-muted-foreground" />
				<input
					ref={inputRef}
					autoFocus
					data-testid="notebook-switcher-input"
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setWalked(null);
					}}
					onKeyDown={onKeyDown}
					placeholder="Switch notebook…"
					className="lh-input flex-1 border-0 bg-transparent text-sm outline-none"
				/>
				<span className="text-[11px] text-muted-foreground/70">Esc</span>
			</div>
			<div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
				{rows.length === 0 && <div className="px-3 py-4 text-xs text-muted-foreground">{query.trim() ? "No matches." : "No notebooks yet."}</div>}
				{rows.map((row, i) => (
					<button
						key={row.item.id}
						type="button"
						data-row={i}
						data-testid="notebook-switcher-row"
						onMouseMove={() => setWalked(row.item.id)}
						onClick={() => go(row.item.id)}
						className={cn("flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm", i === index ? "bg-accent text-foreground" : "text-muted-foreground")}
					>
						<span
							className={cn(
								"flex size-5 shrink-0 items-center justify-center rounded border font-mono text-[11px]",
								row.slot ? "border-primary/50 text-primary" : "border-transparent",
							)}
							data-testid="notebook-switcher-slot"
						>
							{row.slot ?? ""}
						</span>
						<span className="min-w-0 flex-1 truncate">{row.item.title}</span>
						{row.current && <span className="text-[11px] uppercase tracking-wider text-muted-foreground/60">open</span>}
					</button>
				))}
			</div>
			<div className="flex flex-wrap gap-x-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground/70">
				<span>↵ open</span>
				<span>↑↓ / Ctrl+J K walk</span>
				<span>{pinKeys} pin to slot</span>
				<span>{slotKeys} jump to slot</span>
			</div>
		</HostDialog>
	);
}
