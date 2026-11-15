"use client";

/**
 * Sidebar Notes section (docs/notes-first.md): Today, the graph, and the
 * vault's notes newest first. Refetches on navigation (saves happen in the
 * open editor; the list only needs to be fresh when the learner looks).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarIcon, FileTextIcon, NetworkIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { noteHref } from "./notes-page";

interface NoteSummary {
	path: string;
	mtime: number;
}

export function NotesSection() {
	const pathname = usePathname();
	const [notes, setNotes] = useState<NoteSummary[] | null>(null);

	useEffect(() => {
		let live = true;
		fetch("/api/notes")
			.then((r) => (r.ok ? (r.json() as Promise<{ notes: NoteSummary[] }>) : { notes: [] }))
			.then((b) => live && setNotes(b.notes))
			.catch(() => live && setNotes((p) => p ?? []));
		return () => {
			live = false;
		};
	}, [pathname]);

	const row = (active: boolean) =>
		cn("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-accent", active ? "bg-accent text-foreground" : "text-muted-foreground");

	return (
		<div className="flex max-h-[35%] min-h-0 flex-col border-b border-border/60 pb-2" data-testid="notes-section">
			<div className="px-2">
				<Link href="/" className={row(pathname === "/")}>
					<CalendarIcon className="size-3 shrink-0" />
					<span className="flex-1">Today</span>
				</Link>
				<Link href="/graph" className={row(pathname === "/graph")}>
					<NetworkIcon className="size-3 shrink-0" />
					<span className="flex-1">Graph</span>
				</Link>
			</div>
			<div className="mx-3 mb-1 mt-2 text-xs uppercase tracking-widest text-muted-foreground/70">Notes</div>
			<div className="min-h-0 overflow-y-auto px-2">
				{notes === null ? null : notes.length === 0 ? (
					<div className="px-2 py-1 text-xs text-muted-foreground/70">None yet.</div>
				) : (
					notes.map((n) => {
						const href = noteHref(n.path);
						return (
							<Link key={n.path} href={href} className={row(pathname === href)} data-testid="note-row">
								<FileTextIcon className="size-3 shrink-0" />
								<span className="min-w-0 flex-1 truncate">{n.path.replace(/^daily\//, "").replace(/\.md$/, "")}</span>
							</Link>
						);
					})
				)}
			</div>
		</div>
	);
}
