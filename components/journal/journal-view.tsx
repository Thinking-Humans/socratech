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
 * and full-page at /notebook/[id] (journalId). Truth is the server: every
 * change is one operation, the response replaces local state, and
 * `journals-changed` refetches when another writer touched it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2Icon, CodeIcon, LoaderCircleIcon, NetworkIcon, MessageSquareQuoteIcon, NotebookPenIcon, PenLineIcon, PlayIcon, PlusIcon, RotateCcwIcon, SendIcon, SparklesIcon } from "lucide-react";
import { bindingForAction, eventMatchesAction, formatBinding, isTypingSurface, notebookGraphStatus, runnableLang, type CellPatch, type Journal, type JournalCellRole, type KeyAction, type UnderstandingLevel } from "@/src/core";
import { useServerEvent } from "@/components/server-events";
import { JournalApiError, journalApi } from "@/components/journal/journal-api";
import { JournalCellView } from "@/components/journal/journal-cell";
import { PublishPanel } from "@/components/journal/publish-panel";
import { JOURNAL_FOCUS_CELL_EVENT } from "@/components/journal/search-everything";
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
	/** Cells with a run in flight. */
	const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
	/** Cell id → the /ask streaming under it. */
	const [asking, setAsking] = useState<Record<string, { question: string; text: string }>>({});
	const [notice, setNotice] = useState<string | null>(null);
	/** Agent cell id → its answer streaming in. */
	const [streaming, setStreaming] = useState<Record<string, string>>({});
	/** The scroll container — focusing it is the notebook's "scroll mode". */
	const scrollRef = useRef<HTMLDivElement>(null);

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

	const journalIdNow = journal?.id;

	/** Run one code cell; its output + run number come back on the journal. */
	const runCell = useCallback(
		async (cellId: string) => {
			if (!journalIdNow) return;
			setRunning((s) => new Set(s).add(cellId));
			try {
				const { journal: next } = await journalApi.runCell(journalIdNow, cellId);
				setJournal(next);
				setError(null);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setRunning((s) => {
					const n = new Set(s);
					n.delete(cellId);
					return n;
				});
			}
		},
		[journalIdNow],
	);

	/** Run an agent cell: stream the answer in; the server saves it as the output. */
	const runAgent = useCallback(
		async (cellId: string) => {
			if (!journalIdNow) return;
			setRunning((s) => new Set(s).add(cellId));
			setStreaming((m) => ({ ...m, [cellId]: "" }));
			try {
				await journalApi.runAgent(journalIdNow, cellId, (text) => setStreaming((m) => ({ ...m, [cellId]: text })));
				setError(null);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setRunning((s) => {
					const n = new Set(s);
					n.delete(cellId);
					return n;
				});
				setStreaming((m) => {
					const { [cellId]: _, ...rest } = m;
					return rest;
				});
				void load();
			}
		},
		[journalIdNow, load],
	);

	/** The notebook is being read into the graph. */
	const [extracting, setExtracting] = useState(false);

	/** Rate a cell; "stuck" runs the prerequisites agent cell placed above it. */
	const rateCell = useCallback(
		async (cellId: string, level: UnderstandingLevel | null) => {
			if (!journalIdNow) return;
			try {
				const { journal: next, prereqCellId } = await journalApi.rateCell(journalIdNow, cellId, level);
				setJournal(next);
				setError(null);
				const prereq = prereqCellId ? next.cells.find((c) => c.id === prereqCellId) : undefined;
				if (prereq && !prereq.output?.trim()) void runAgent(prereq.id);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[journalIdNow, runAgent],
	);

	/** Read the whole notebook into the graph (only ever on request — or on publish). */
	const extractNotebook = useCallback(async () => {
		if (!journalIdNow) return;
		setExtracting(true);
		try {
			const { journal: next, outcome, stats } = await journalApi.extractNotebook(journalIdNow);
			setJournal(next);
			setError(null);
			const msg: Record<string, string> = {
				extracted: `Read into the graph: ${stats?.nodes ?? 0} new idea${stats?.nodes === 1 ? "" : "s"}, ${stats?.chains ?? 0} new chain${stats?.chains === 1 ? "" : "s"} (existing ideas were linked, not duplicated).`,
				unchanged: "Unchanged since it was last read into the graph.",
				withdrawn: "The notebook has no writing of yours left — its ideas were withdrawn from the graph.",
				nothing: "Nothing to read yet: the graph reads your markdown and aside cells.",
				"graph-off": "The knowledge graph is turned off in Settings.",
				"models-missing": "Pick models in Settings → Models first.",
			};
			setNotice(msg[outcome] ?? outcome);
			setTimeout(() => setNotice(null), 6000);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setExtracting(false);
		}
	}, [journalIdNow]);

	/** Stream an answer under the cell; the server saves it as an aside. */
	const askCell = useCallback(
		async (cellId: string, question: string) => {
			if (!journalIdNow) return;
			setAsking((a) => ({ ...a, [cellId]: { question, text: "" } }));
			try {
				await journalApi.askCell(journalIdNow, cellId, question, (text) => setAsking((a) => ({ ...a, [cellId]: { question, text } })));
				setError(null);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setAsking((a) => {
					const { [cellId]: _, ...rest } = a;
					return rest;
				});
				void load();
			}
		},
		[journalIdNow, load],
	);

	const runnableIds = (journal?.cells ?? []).filter((c) => c.role === "code" && runnableLang(c.lang) && c.source.trim()).map((c) => c.id);

	const runAll = async () => {
		for (const id of runnableIds) await runCell(id);
	};

	const restartKernel = useCallback(async () => {
		if (!journalIdNow) return;
		try {
			await journalApi.restartKernel(journalIdNow);
			setNotice("Python restarted — variables cleared.");
			setTimeout(() => setNotice(null), 4000);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [journalIdNow]);

	const addCell = useCallback(
		async (role: JournalCellRole, afterId?: string) => {
			const before = new Set(journal?.cells.map((c) => c.id));
			const next = await run((j) => journalApi.addCell(j.id, { role, ...(role === "code" ? { lang: "python" } : {}) }, afterId));
			const added = next?.cells.find((c) => !before.has(c.id));
			if (added) setEditingId(added.id);
		},
		[journal, run],
	);

	/** Focus a cell's root (command mode) and bring it into view. */
	const focusCell = useCallback((cellId: string | undefined) => {
		if (!cellId) return;
		const el = document.getElementById(`cell-${cellId}`);
		if (!el) return;
		el.focus({ preventScroll: true });
		el.scrollIntoView({ block: "nearest" });
	}, []);

	// A fresh notebook is one empty markdown cell: open straight into editing it.
	const autoEditedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!journal || autoEditedRef.current === journal.id) return;
		autoEditedRef.current = journal.id;
		const only = journal.cells.length === 1 ? journal.cells[0] : undefined;
		if (only && only.role === "reflection" && only.source === "") setEditingId(only.id);
	}, [journal]);

	// Search-everything lands here: a #cell-… hash on load, or the event when
	// this journal is already open.
	const loaded = journal !== undefined && journal !== null;
	useEffect(() => {
		if (!loaded) return;
		const m = /^#cell-(.+)$/.exec(window.location.hash);
		if (m) requestAnimationFrame(() => {
			const el = document.getElementById(`cell-${m[1]}`);
			el?.focus({ preventScroll: true });
			el?.scrollIntoView({ block: "center" });
		});
		const onFocus = (e: Event) => {
			const { journalId: jid, cellId } = (e as CustomEvent<{ journalId: string; cellId: string }>).detail;
			if (jid !== journalIdNow) return;
			const el = document.getElementById(`cell-${cellId}`);
			el?.focus({ preventScroll: true });
			el?.scrollIntoView({ block: "center" });
		};
		window.addEventListener(JOURNAL_FOCUS_CELL_EVENT, onFocus);
		return () => window.removeEventListener(JOURNAL_FOCUS_CELL_EVENT, onFocus);
	}, [loaded, journalIdNow]);

	// Launched from the graph (?run=<cellId>, owner 2026-11-15): start that
	// agent cell once. The ref survives StrictMode's double effect; the param
	// is stripped so a reload never re-runs it, and a cell that already has
	// an answer is left alone.
	const launchRunRef = useRef<string | null>(null);
	useEffect(() => {
		if (!loaded || !journal) return;
		const params = new URLSearchParams(window.location.search);
		const runId = params.get("run");
		if (!runId || launchRunRef.current === runId) return;
		launchRunRef.current = runId;
		params.delete("run");
		const rest = params.toString();
		window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
		const cell = journal.cells.find((c) => c.id === runId);
		if (cell?.role === "agent" && !cell.output?.trim()) void runAgent(runId);
	}, [loaded, journal, runAgent]);

	// The notebook's keys (Jupyter-style command mode), all from the registry
	// so Settings → Keyboard rebinds them. Edit-mode keys live in the cell.
	//   new code / markdown cell below — any mode; agent cell — command mode
	//   (in edit mode Mod+L is the cell's inline ask)
	//   Esc on a focused cell → scroll mode (the container takes focus)
	//   Tab → the top cell · ↑/↓ → previous / next cell
	const keysRef = useRef({ cells: [] as string[], editingId: null as string | null, addCell, rateCell, extractNotebook });
	keysRef.current = { cells: journal?.cells.map((c) => c.id) ?? [], editingId, addCell, rateCell, extractNotebook };
	useEffect(() => {
		if (!loaded) return;
		const onKey = (e: KeyboardEvent) => {
			// The interaction provider pre-claims every Tab (native focus
			// traversal is dead app-wide), so Tab arrives defaultPrevented.
			if (e.defaultPrevented && e.key !== "Tab") return;
			const root = scrollRef.current;
			const target = e.target as HTMLElement | null;
			// Only this notebook's keys: focus inside it, or nowhere in particular.
			if (!root || !target || (!root.contains(target) && target !== document.body)) return;
			const { cells, editingId: editing, addCell: add } = keysRef.current;
			const cellEl = target.closest<HTMLElement>("[data-cell-id]");
			const cellId = cellEl?.dataset.cellId ?? editing ?? undefined;
			const onCellRoot = cellEl !== null && target === cellEl;
			const claim = () => {
				e.preventDefault();
				e.stopPropagation();
			};
			const newRole: JournalCellRole | null = eventMatchesAction(e, "journal-new-code")
				? "code"
				: eventMatchesAction(e, "journal-new-markdown")
					? "reflection"
					: eventMatchesAction(e, "journal-new-agent") && !isTypingSurface(e)
						? "agent"
						: null;
			if (newRole) {
				claim();
				void add(newRole, cellId);
				return;
			}
			if (isTypingSurface(e)) return; // edit mode: the cell owns the rest
			if (onCellRoot && eventMatchesAction(e, "journal-exit-cell")) {
				claim();
				root.focus({ preventScroll: true });
				return;
			}
			if (eventMatchesAction(e, "journal-focus-top")) {
				claim();
				focusCell(cells[0]);
				root.scrollTo({ top: 0 });
				return;
			}
			if (onCellRoot && cellId) {
				const rate: UnderstandingLevel | null = eventMatchesAction(e, "journal-rate-own")
					? "own"
					: eventMatchesAction(e, "journal-rate-helped")
						? "helped"
						: eventMatchesAction(e, "journal-rate-stuck")
							? "stuck"
							: null;
				if (rate) {
					claim();
					void keysRef.current.rateCell(cellId, rate);
					return;
				}
				if (eventMatchesAction(e, "journal-extract-cell")) {
					claim();
					void keysRef.current.extractNotebook();
					return;
				}
				const i = cells.indexOf(cellId);
				if (eventMatchesAction(e, "journal-next-cell") && i < cells.length - 1) {
					claim();
					focusCell(cells[i + 1]);
				} else if (eventMatchesAction(e, "journal-prev-cell") && i > 0) {
					claim();
					focusCell(cells[i - 1]);
				}
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [loaded, focusCell]);

	if (journal === undefined) {
		return <div className={cn("p-6 text-sm text-muted-foreground", className)}>{error ?? "Loading notebook…"}</div>;
	}

	if (journal === null) {
		return (
			<div className={cn("flex flex-col items-center justify-center gap-3 p-10 text-center", className)} data-testid="journal-empty">
				<NotebookPenIcon className="size-8 text-muted-foreground/60" />
				<p className="max-w-sm text-sm text-muted-foreground">
					No notebook yet for this session — start one by hand.
				</p>
				{chatId && (
					<button
						type="button"
						data-testid="journal-start"
						onClick={async () => {
							try {
								setJournal(await journalApi.create({ title: chatTitle ?? "Untitled notebook", chatId }));
							} catch (err) {
								setError(err instanceof Error ? err.message : String(err));
							}
						}}
						className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<PlusIcon className="size-3" />
						Start notebook
					</button>
				)}
				{error && <p className="text-xs text-destructive">{error}</p>}
			</div>
		);
	}

	const published = journal.publications.at(-1);
	const publicCount = journal.cells.filter((c) => c.publish).length;
	const graphStatus = notebookGraphStatus(journal);

	return (
		<div ref={scrollRef} tabIndex={-1} className={cn("overflow-y-auto outline-none", className)} data-testid="journal-view">
			<div className="mx-auto flex w-full max-w-[46rem] flex-col gap-4 px-4 pb-24 pt-6">
				<header className="flex flex-col gap-2">
					<input
						key={`title-${journal.id}-${journal.title}`}
						aria-label="Notebook title"
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
						{runnableIds.length > 0 && (
							<>
								<button
									type="button"
									data-testid="journal-run-all"
									disabled={running.size > 0}
									onClick={() => void runAll()}
									title="Run every python/cpp cell, top to bottom"
									className="flex items-center gap-1 rounded-full border border-border/80 px-2 py-0.5 uppercase tracking-wide transition-colors hover:text-foreground disabled:opacity-50"
								>
									<PlayIcon className="size-3" />
									Run all
								</button>
								<button
									type="button"
									data-testid="journal-restart-kernel"
									onClick={() => void restartKernel()}
									title="Restart Python (clears variables)"
									className="flex items-center gap-1 rounded-full border border-border/80 px-2 py-0.5 uppercase tracking-wide transition-colors hover:text-foreground"
								>
									<RotateCcwIcon className="size-3" />
									Restart
								</button>
							</>
						)}
						<button
							type="button"
							data-testid="journal-extract"
							disabled={extracting}
							onClick={() => void extractNotebook()}
							title={
								graphStatus === "current"
									? "This notebook is in the graph"
									: graphStatus === "stale"
										? "Edited since it was read into the graph — read it again to replace its ideas (g)"
										: "Read this notebook's markdown and asides into the knowledge graph (g)"
							}
							className={cn(
								"flex items-center gap-1 rounded-full border border-border/80 px-2 py-0.5 uppercase tracking-wide transition-colors hover:text-foreground disabled:opacity-60",
								graphStatus === "current" && "border-primary/50 text-primary",
								graphStatus === "stale" && "border-warning/60 text-warning",
							)}
						>
							{extracting ? <LoaderCircleIcon className="size-3 animate-spin" /> : graphStatus === "current" ? <CheckCircle2Icon className="size-3" /> : <NetworkIcon className="size-3" />}
							{extracting ? "Reading…" : graphStatus === "current" ? `In graph · ${journal.graph!.nodes} idea${journal.graph!.nodes === 1 ? "" : "s"}` : graphStatus === "stale" ? "Update graph" : "Add to graph"}
						</button>
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
					{notice && !error && (
						<p className="text-xs text-muted-foreground" role="status">
							{notice}
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
							<p className="text-sm text-muted-foreground">Empty notebook. Ctrl/⌘+M markdown · Ctrl/⌘+B code · Ctrl/⌘+L agent — Python and C++ run here; /ask in any cell.</p>
						)}
						{journal.cells.map((cell, i) => (
							<JournalCellView
								key={cell.id}
								journalId={journal.id}
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
								onRun={() => (cell.role === "agent" ? runAgent(cell.id) : runCell(cell.id))}
								onAsk={(q) => askCell(cell.id, q)}
								running={running.has(cell.id)}
								asking={asking[cell.id] ?? null}
								streaming={streaming[cell.id] ?? null}
								onRate={(level) => void rateCell(cell.id, level)}
								onJournal={setJournal}
							/>
						))}
						<div className="flex flex-wrap gap-1.5 pt-2" data-testid="journal-add">
							<AddButton icon={<CodeIcon className="size-3" />} label="Code" hint="journal-new-code" onClick={() => void addCell("code")} />
							<AddButton icon={<PenLineIcon className="size-3" />} label="Markdown" hint="journal-new-markdown" onClick={() => void addCell("reflection")} />
							<AddButton icon={<SparklesIcon className="size-3" />} label="Agent" hint="journal-new-agent" onClick={() => void addCell("agent")} />
							<AddButton icon={<MessageSquareQuoteIcon className="size-3" />} label="Aside" onClick={() => void addCell("aside")} />
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function AddButton({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint?: KeyAction; onClick: () => void }) {
	const [keys, setKeys] = useState("");
	// Post-mount: the binding reads localStorage overrides.
	useEffect(() => setKeys(hint ? formatBinding(bindingForAction(hint)) : ""), [hint]);
	return (
		<button
			type="button"
			title={keys ? `${label} (${keys})` : label}
			onClick={onClick}
			className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:border-solid hover:bg-accent hover:text-foreground"
		>
			<PlusIcon className="size-3" />
			{icon}
			{label}
		</button>
	);
}
