"use client";

/**
 * Search everything (Mod+K, owner 2026-11-15): one field over every
 * notebook — titles, tags, cell text, code and outputs. ↑/↓ walk the hits,
 * Enter opens one (the cell gets focus and scrolls into view), Esc closes.
 */

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SearchIcon } from "lucide-react";
import type { JournalSearchHit } from "@/src/core";
import { HostDialog } from "@/components/host-dialog";
import { cn } from "@/lib/utils";

/** The journal view answers on this: focus + scroll a cell into view. */
export const JOURNAL_FOCUS_CELL_EVENT = "lh:journal-focus-cell";

export function focusJournalCell(router: ReturnType<typeof useRouter>, journalId: string, cellId?: string): void {
	const path = `/notebook/${journalId}`;
	if (window.location.pathname !== path) router.push(cellId ? `${path}#cell-${cellId}` : path);
	// After the dialog has closed and handed focus back to its opener.
	else if (cellId) setTimeout(() => window.dispatchEvent(new CustomEvent(JOURNAL_FOCUS_CELL_EVENT, { detail: { journalId, cellId } })), 80);
}

const ROLE_LABEL: Record<string, string> = { reflection: "markdown", code: "code", agent: "agent", aside: "aside" };

export function SearchEverything({ open, onClose }: { open: boolean; onClose: () => void }) {
	const router = useRouter();
	const headingId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<JournalSearchHit[]>([]);
	const [index, setIndex] = useState(0);

	useEffect(() => {
		if (!open) return;
		setIndex(0);
		const q = query.trim();
		if (!q) {
			setHits([]);
			return;
		}
		const ctrl = new AbortController();
		const t = setTimeout(() => {
			fetch(`/api/journals/search?q=${encodeURIComponent(q)}`, { cache: "no-store", signal: ctrl.signal })
				.then((r) => r.json())
				.then((d: { hits?: JournalSearchHit[] }) => setHits(d.hits ?? []))
				.catch(() => undefined);
		}, 120);
		return () => {
			clearTimeout(t);
			ctrl.abort();
		};
	}, [query, open]);

	const pick = (hit: JournalSearchHit | undefined) => {
		if (!hit) return;
		onClose();
		focusJournalCell(router, hit.journalId, hit.cellId);
	};

	return (
		<HostDialog
			open={open}
			onClose={() => {
				onClose();
				return "closed";
			}}
			aria-labelledby={headingId}
			initialFocusRef={inputRef}
			backdropProps={{ "data-testid": "search-everything", className: "fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" }}
			frame={<div className="flex max-h-[70vh] w-full max-w-[40rem] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()} />}
		>
			<span id={headingId} className="sr-only">
				Search everything
			</span>
			<div className="flex items-center gap-2 border-b border-border px-3 py-2">
				<SearchIcon className="size-4 text-muted-foreground" />
				<input
					ref={inputRef}
					autoFocus
					data-testid="search-everything-input"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							e.preventDefault();
							const n = hits.length;
							if (n) setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
						} else if (e.key === "Enter") {
							e.preventDefault();
							pick(hits[index]);
						}
					}}
					placeholder="Search every notebook — titles, text, code, outputs…"
					className="lh-input flex-1 border-0 bg-transparent text-sm outline-none"
				/>
				<span className="text-[11px] text-muted-foreground/70">Esc</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-1">
				{query.trim() && hits.length === 0 && <div className="px-3 py-4 text-xs text-muted-foreground">No matches.</div>}
				{hits.map((hit, i) => (
					<button
						key={`${hit.journalId}-${hit.cellId ?? "title"}`}
						type="button"
						data-testid="search-hit"
						onMouseEnter={() => setIndex(i)}
						onClick={() => pick(hit)}
						className={cn("flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left", i === index ? "bg-accent" : "hover:bg-accent/50")}
					>
						<span className="flex w-full items-center gap-2 text-xs text-muted-foreground">
							<span className="truncate font-medium text-foreground">{hit.journalTitle}</span>
							{hit.role && <span className="uppercase tracking-wider">{ROLE_LABEL[hit.role] ?? hit.role}</span>}
						</span>
						{hit.snippet && <span className="line-clamp-2 font-mono text-xs text-muted-foreground">{hit.snippet}</span>}
					</button>
				))}
			</div>
		</HostDialog>
	);
}
