"use client";

/**
 * THE JOURNAL VIEW (learn-in-public, owner 2026-11-15): one session's (or a
 * standalone) cell list — exercises, attempts and verdicts filled in from
 * practice/improvise, plus the learner's reflections, asides and code.
 * Each cell's eye toggles whether it reaches the published post; Preview
 * shows the exact markdown the bundle will carry.
 *
 * Mounted two ways: as the session's Journal tab (chatId — an absolute
 * overlay over the live transcript, so the chat keeps running underneath)
 * and full-page at /journal/[id] (journalId). Truth is the server: every
 * change is one operation, the response replaces local state, and
 * `journals-changed` refetches when another writer touched it.
 */

import { useCallback, useEffect, useState } from "react";
import { CodeIcon, MessageSquareQuoteIcon, NotebookPenIcon, PenLineIcon, PlusIcon, SendIcon } from "lucide-react";
import type { CellPatch, Journal, JournalCellRole } from "@/src/core";
import { useServerEvent } from "@/components/server-events";
import { JournalApiError, journalApi } from "@/components/journal/journal-api";
import { JournalCellView } from "@/components/journal/journal-cell";
import { PublishPanel } from "@/components/journal/publish-panel";
import { cn } from "@/lib/utils";

const today = () => new Date().toISOString().slice(0, 10);

export function JournalView({
	chatId,
	journalId,
	chatTitle,
	className,
}: {
	chatId?: string;
	journalId?: string;
	/** The session's title — the default for "Start journal". */
	chatTitle?: string;
	className?: string;
}) {
	/** undefined = loading; null = this session has no journal yet. */
	const [journal, setJournal] = useState<Journal | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	/** The header panel: the server dry run as preview, or the publish confirm. */
	const [panel, setPanel] = useState<"preview" | "publish" | null>(null);

	const load = useCallback(async () => {
		try {
			const next = journalId ? await journalApi.get(journalId) : chatId ? await journalApi.byChat(chatId) : null;
			setJournal(next);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			if (err instanceof JournalApiError && err.status === 404) setJournal(null);
		}
	}, [chatId, journalId]);

	useEffect(() => {
		void load();
	}, [load]);

	useServerEvent("journals-changed", (e) => {
		if ((journalId && e.journalId === journalId) || (chatId && e.chatId === chatId) || (journal && e.journalId === journal.id)) void load();
	});

	/** Run one operation; adopt the fresh journal it returns. A 409 reloads. */
	const run = useCallback(
		async (op: (j: Journal) => Promise<Journal>): Promise<Journal | null> => {
			if (!journal) return null;
			try {
				const next = await op(journal);
				setJournal(next);
				setError(null);
				return next;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				if (err instanceof JournalApiError && err.status === 409) void load();
				return null;
			}
		},
		[journal, load],
	);

	const addCell = useCallback(
		async (role: JournalCellRole, afterId?: string) => {
			const before = new Set(journal?.cells.map((c) => c.id));
			const next = await run((j) => journalApi.addCell(j.id, { role, ...(role === "code" ? { lang: "python" } : {}) }, afterId));
			const added = next?.cells.find((c) => !before.has(c.id));
			if (added) setEditingId(added.id);
		},
		[journal, run],
	);

	if (journal === undefined) {
		return <div className={cn("p-6 text-sm text-muted-foreground", className)}>{error ?? "Loading journal…"}</div>;
	}

	if (journal === null) {
		return (
			<div className={cn("flex flex-col items-center justify-center gap-3 p-10 text-center", className)} data-testid="journal-empty">
				<NotebookPenIcon className="size-8 text-muted-foreground/60" />
				<p className="max-w-sm text-sm text-muted-foreground">
					No journal yet. Practice and improvise sessions start one with their first exercise; here you can start one by hand.
				</p>
				{chatId && (
					<button
						type="button"
						data-testid="journal-start"
						onClick={async () => {
							try {
								setJournal(await journalApi.create({ title: chatTitle ?? "Untitled journal", chatId }));
							} catch (err) {
								setError(err instanceof Error ? err.message : String(err));
							}
						}}
						className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<PlusIcon className="size-3" />
						Start journal
					</button>
				)}
				{error && <p className="text-xs text-destructive">{error}</p>}
			</div>
		);
	}

	const published = journal.publications.at(-1);
	const publicCount = journal.cells.filter((c) => c.publish).length;

	return (
		<div className={cn("overflow-y-auto", className)} data-testid="journal-view">
			<div className="mx-auto flex w-full max-w-[46rem] flex-col gap-4 px-4 pb-24 pt-6">
				<header className="flex flex-col gap-2">
					<input
						key={`title-${journal.id}-${journal.title}`}
						aria-label="Journal title"
						defaultValue={journal.title}
						onBlur={(e) => {
							const title = e.target.value.trim();
							if (title && title !== journal.title) void run((j) => journalApi.patchMeta(j.id, { title }));
						}}
						onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
						// No lh-input: its unlayered font-size would beat text-2xl.
						className="w-full border-0 bg-transparent font-title text-2xl tracking-tight outline-none"
					/>
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						<span className="flex items-center gap-1 font-mono">
							/{published ? published.path.split("/").at(-1) : `${today()}-`}
							{!published && (
								<input
									key={`slug-${journal.slug}`}
									aria-label="Slug"
									defaultValue={journal.slug}
									onBlur={(e) => {
										const slug = e.target.value.trim();
										if (slug && slug !== journal.slug) void run((j) => journalApi.patchMeta(j.id, { slug }));
									}}
									onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
									className="lh-input min-w-24 border-0 border-b border-dashed border-border bg-transparent px-0 font-mono outline-none [field-sizing:content]"
								/>
							)}
						</span>
						<input
							key={`tags-${journal.tags.join(",")}`}
							aria-label="Tags"
							defaultValue={journal.tags.join(", ")}
							placeholder="tags, comma separated"
							onBlur={(e) => {
								const tags = e.target.value.split(",").map((t) => t.trim()).filter(Boolean);
								if (tags.join(",") !== journal.tags.join(",")) void run((j) => journalApi.patchMeta(j.id, { tags }));
							}}
							onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
							className="lh-input w-44 min-w-0 border-0 border-b border-dashed border-border bg-transparent px-0 outline-none"
						/>
						<span>
							{publicCount}/{journal.cells.length} cells public
						</span>
						{published && (
							<span data-testid="journal-published">
								published {published.at.slice(0, 10)}
								{published.url && (
									<>
										{" · "}
										<a href={published.url} target="_blank" rel="noreferrer" className="underline">
											view
										</a>
									</>
								)}
							</span>
						)}
						<span className="flex-1" />
						<button
							type="button"
							data-testid="journal-preview-toggle"
							onClick={() => setPanel((p) => (p === "preview" ? null : "preview"))}
							className={cn(
								"rounded-full border px-2 py-0.5 uppercase tracking-wide transition-colors",
								panel === "preview" ? "border-primary/60 text-foreground" : "border-border/80 hover:text-foreground",
							)}
						>
							{panel === "preview" ? "Edit" : "Preview"}
						</button>
						<button
							type="button"
							data-testid="journal-publish"
							onClick={() => setPanel((p) => (p === "publish" ? null : "publish"))}
							className={cn(
								"flex items-center gap-1 rounded-full border px-2 py-0.5 uppercase tracking-wide transition-colors",
								panel === "publish" ? "border-primary bg-primary/10 text-foreground" : "border-primary/50 text-primary hover:bg-primary/10",
							)}
						>
							<SendIcon className="size-3" />
							{published ? "Republish" : "Publish"}
						</button>
					</div>
					{error && (
						<p className="text-xs text-destructive" role="alert">
							{error}
						</p>
					)}
				</header>

				{panel ? (
					<PublishPanel
						key={panel}
						journalId={journal.id}
						mode={panel}
						revision={journal.updatedAt}
						onClose={() => setPanel(null)}
						onPublished={(r) => setJournal(r.journal)}
					/>
				) : (
					<>
						{journal.cells.length === 0 && (
							<p className="text-sm text-muted-foreground">Empty journal. Write what you learned — exercises from practice land here too.</p>
						)}
						{journal.cells.map((cell, i) => (
							<JournalCellView
								key={cell.id}
								cell={cell}
								index={i}
								count={journal.cells.length}
								editing={editingId === cell.id}
								onEdit={() => setEditingId(cell.id)}
								onDone={() => setEditingId((id) => (id === cell.id ? null : id))}
								onCommit={async (patch: CellPatch) => {
									await run((j) => journalApi.patchCell(j.id, cell.id, patch, cell.updatedAt));
								}}
								onAddBelow={() => void addCell(cell.role === "code" ? "code" : "reflection", cell.id)}
								onMove={(to) => void run((j) => journalApi.moveCell(j.id, cell.id, to))}
								onDelete={() => void run((j) => journalApi.deleteCell(j.id, cell.id))}
							/>
						))}
						<div className="flex flex-wrap gap-1.5 pt-2" data-testid="journal-add">
							<AddButton icon={<PenLineIcon className="size-3" />} label="Reflection" onClick={() => void addCell("reflection")} />
							<AddButton icon={<MessageSquareQuoteIcon className="size-3" />} label="Aside" onClick={() => void addCell("aside")} />
							<AddButton icon={<CodeIcon className="size-3" />} label="Code" onClick={() => void addCell("code")} />
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function AddButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:border-solid hover:bg-accent hover:text-foreground"
		>
			<PlusIcon className="size-3" />
			{icon}
			{label}
		</button>
	);
}
