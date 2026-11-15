"use client";

import { TopBar } from "@/components/top-bar";
import { JournalView } from "@/components/journal/journal-view";

/** /journal/[id]: the standalone journal surface — the shared top bar
 *  (title law: the journal names itself in its own header) + the view. */
export function JournalPage({ journalId }: { journalId: string }) {
	return (
		<div className="flex h-dvh min-w-0 flex-1 flex-col">
			<TopBar>
				<span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Journal</span>
				<div className="min-w-4 flex-1" aria-hidden="true" />
			</TopBar>
			<JournalView journalId={journalId} className="min-h-0 flex-1" />
		</div>
	);
}
