"use client";

/**
 * The sidebar's Journals section (owner, 2026-11-15): every journal,
 * newest activity first, a dot when published; "+" starts a standalone
 * journal. A session's journal opens on that session's Journal tab; a
 * standalone one at /journal/[id]. Live through `journals-changed`.
 */

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { NotebookPenIcon, PlusIcon } from "lucide-react";
import type { JournalSummary } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { journalApi } from "@/components/journal/journal-api";
import { cn } from "@/lib/utils";

export function journalHref(j: Pick<JournalSummary, "id" | "chatId">): string {
	return j.chatId ? `/chat/${j.chatId}?view=journal` : `/journal/${j.id}`;
}

export function JournalsSection() {
	const router = useRouter();
	const pathname = usePathname();
	const [journals, setJournals] = useState<JournalSummary[] | null>(null);

	const load = useCallback(async () => {
		try {
			setJournals(await journalApi.list());
		} catch {
			setJournals((prev) => prev ?? []);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);
	useServerEvent("journals-changed", () => void load());
	useServerResync(() => void load());

	return (
		<div className="flex max-h-[30%] min-h-0 flex-col border-t border-border/60 pt-2" data-testid="journals-section">
			<div className="mx-3 mb-1 flex items-center gap-2">
				<span className="flex-1 text-xs uppercase tracking-widest text-muted-foreground/70">Journals</span>
				<button
					type="button"
					aria-label="New journal"
					title="New journal"
					data-testid="journal-new"
					onClick={async () => {
						const j = await journalApi.create({ title: "Untitled journal" });
						router.push(`/journal/${j.id}`);
					}}
					className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<PlusIcon className="size-3" />
				</button>
			</div>
			<div className="min-h-0 overflow-y-auto px-2 pb-1">
				{journals === null ? null : journals.length === 0 ? (
					<div className="px-2 py-1 text-xs text-muted-foreground/70">None yet.</div>
				) : (
					journals.map((j) => {
						const active = pathname === `/journal/${j.id}`;
						return (
							<button
								key={j.id}
								type="button"
								data-testid="journal-row"
								onClick={() => router.push(journalHref(j))}
								className={cn(
									"flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-accent",
									active ? "bg-accent text-foreground" : "text-muted-foreground",
								)}
							>
								<NotebookPenIcon className="size-3 shrink-0" />
								<span className="min-w-0 flex-1 truncate">{j.title}</span>
								{j.lastPublishedAt && <span className="size-1.5 shrink-0 rounded-full bg-primary" title="Published" aria-label="Published" />}
							</button>
						);
					})
				)}
			</div>
		</div>
	);
}
