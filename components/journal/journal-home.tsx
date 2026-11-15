"use client";

/** Notebook home with no notebooks yet: one button that starts one. */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { NotebookPenIcon, PlusIcon } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { createNotebook } from "@/components/journal/journal-api";

export function JournalHome() {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	return (
		<div className="flex h-dvh min-w-0 flex-1 flex-col">
			<TopBar>
				<span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Notebook</span>
				<div className="min-w-4 flex-1" aria-hidden="true" />
			</TopBar>
			<div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center" data-testid="journal-home">
				<NotebookPenIcon className="size-8 text-muted-foreground/60" />
				<p className="max-w-sm text-sm text-muted-foreground">
					Write, run Python and C++, <code>/ask</code> about any cell, and publish the notebook to your blog.
				</p>
				<button
					type="button"
					data-testid="journal-home-new"
					onClick={async () => {
						try {
							await createNotebook(router);
						} catch (err) {
							setError(err instanceof Error ? err.message : String(err));
						}
					}}
					className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<PlusIcon className="size-3" />
					New notebook
				</button>
				{error && <p className="text-xs text-destructive">{error}</p>}
			</div>
		</div>
	);
}
