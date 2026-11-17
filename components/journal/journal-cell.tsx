"use client";

/**
 * One journal cell, Jupyter-style (owner, 2026-11-15): rendered by default
 * (markdown + KaTeX through MessageResponse; code as a highlighted fence);
 * click or Enter edits the raw text in place; Esc or click-away commits and
 * renders; Ctrl/⌘+Enter commits (and RUNS a python/cpp cell); Shift+Enter
 * commits, runs, and opens a new cell below. A `/ask …` line (in code:
 * `# /ask …` or `// /ask …` too) is lifted out on commit and asked about
 * the whole cell — the answer streams below and lands as a private aside.
 * The draft lives here while editing, so a refetch triggered by another
 * writer (turn-end fill, MCP) never clobbers what is being typed.
 * Text highlighted in the RENDERED cell (its body, output or agent answer)
 * offers Ask / Explain (owner, 2026-11-17) — the same inline-ask box, under
 * the cell.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownIcon, ArrowUpIcon, EyeIcon, EyeOffIcon, LayersIcon, LoaderCircleIcon, PaperclipIcon, PlayIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import {
	JOURNAL_CELL_ROLES,
	MEDIA_ACCEPT,
	eventMatchesAction,
	extractCellAsks,
	isMediaName,
	runnableLang,
	journalMediaUrl,
	mediaEmbedLine,
	type CellPatch,
	type JournalCell,
	type JournalCellRole,
} from "@/src/core";
import { journalApi } from "@/components/journal/journal-api";
import { InlineAskBox, type InlineAskRequest } from "@/components/journal/inline-ask";
import type { InlineAskMode } from "@/src/core";
import { CellLearningBar } from "@/components/journal/cell-learning";
import { bindingForAction, eventBinding } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";

const ROLE_LABEL: Record<JournalCellRole, string> = {
	reflection: "Markdown",
	aside: "Aside",
	code: "Code",
	agent: "Agent",
	exercise: "Exercise",
	attempt: "Attempt",
	verdict: "Verdict",
};

/** The notebook's own cell types. exercise / attempt / verdict were the
 *  old journal's session artifacts (owner, 2026-11-15: journals removed) —
 *  only shown for a cell that already has one. */
const PICKABLE_ROLES: readonly JournalCellRole[] = ["reflection", "code", "agent", "aside"];

const ROLE_TONE: Record<JournalCellRole, string> = {
	reflection: "",
	aside: "border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground",
	code: "",
	agent: "",
	exercise: "rounded-md border border-primary/30 bg-primary/5 px-3 py-2",
	attempt: "rounded-md border border-border bg-muted/40 px-3 py-2",
	verdict: "rounded-md border border-border bg-muted/20 px-3 py-2",
};

function fenced(text: string, info: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	const ticks = "`".repeat(Math.max(3, longest + 1));
	return `${ticks}${info}\n${text.replace(/\n+$/, "")}\n${ticks}`;
}

/**
 * Markdown with media embeds: a whole-line `![alt](media/x.png)` (or .mp4)
 * is drawn here as an image / player from the journal's own media route.
 * Everything else renders as markdown — where images stay blocked.
 */
function MarkdownWithMedia({ text, journalId }: { text: string; journalId: string }) {
	const blocks: React.ReactNode[] = [];
	let buf: string[] = [];
	const flush = () => {
		const md = buf.join("\n");
		if (md.trim()) blocks.push(<MessageResponse key={`md-${blocks.length}`}>{md}</MessageResponse>);
		buf = [];
	};
	for (const line of text.split("\n")) {
		const embed = mediaEmbedLine(line);
		if (!embed) {
			buf.push(line);
			continue;
		}
		flush();
		const src = journalMediaUrl(journalId, embed.name);
		blocks.push(
			embed.kind === "video" ? (
				<video
					key={`m-${blocks.length}`}
					controls
					preload="metadata"
					aria-label={embed.alt || embed.name}
					src={src}
					className="my-2 max-h-[28rem] w-full rounded-md border border-border bg-black"
					data-testid="journal-video"
				/>
			) : (
				// eslint-disable-next-line @next/next/no-img-element -- local, user-uploaded media
				<img key={`m-${blocks.length}`} src={src} alt={embed.alt} loading="lazy" className="my-2 max-h-[28rem] max-w-full rounded-md" data-testid="journal-image" />
			),
		);
	}
	flush();
	return <>{blocks}</>;
}

/** The journal view asks a cell to open its ask box on the highlighted text (Mod+L). */
export const JOURNAL_ASK_SELECTION_EVENT = "lh:journal-ask-selection";

/** Rendered cell content a highlight may be asked about. */
const ASK_SCOPE = "[data-ask-scope]";
const BLOCK_TAGS = "p, li, pre, h1, h2, h3, h4, h5, h6, blockquote, tr, br, div";

/** A range's text as the learner reads it: a formula as its TeX source, one
 *  line per block, no button labels. */
function rangeText(range: Range): string {
	const holder = document.createElement("div");
	holder.append(range.cloneContents());
	for (const el of holder.querySelectorAll("button, [aria-hidden=true]:not(.katex-html)")) el.remove();
	for (const formula of holder.querySelectorAll(".katex")) {
		const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
		formula.replaceWith(tex ? `$${tex}$` : (formula.querySelector(".katex-html")?.textContent ?? ""));
	}
	for (const block of holder.querySelectorAll(BLOCK_TAGS)) block.after("\n");
	return (holder.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

/** The text highlighted inside ONE rendered cell, if any (not a text box's selection). */
export function selectedCellText(): { cellId: string; cell: HTMLElement; text: string; range: Range } | null {
	const sel = window.getSelection();
	if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	const within = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(ASK_SCOPE) ?? null;
	const from = within(range.startContainer);
	const to = within(range.endContainer);
	const cell = from?.closest<HTMLElement>("[data-cell-id]");
	if (!from || !to || !cell || to.closest("[data-cell-id]") !== cell) return null;
	const text = rangeText(range);
	const cellId = cell.dataset.cellId;
	return text && cellId ? { cellId, cell, text, range } : null;
}

export interface JournalCellProps {
	journalId: string;
	cell: JournalCell;
	index: number;
	count: number;
	editing: boolean;
	onEdit: () => void;
	onDone: () => void;
	onCommit: (patch: CellPatch) => Promise<void>;
	onAddBelow: () => void;
	onMove: (toIndex: number) => void;
	onDelete: () => void;
	/** Run this (saved) cell: a python/cpp code cell, or an agent cell. */
	onRun: () => Promise<void>;
	/** Ask about this cell; resolves when the answer has streamed in. */
	onAsk: (question: string) => Promise<void>;
	/** Open the flashcards dialog for this cell (F). */
	onFlashcards: () => void;
	/** Inline ask → "Save as cell": keep an answer as a private aside below this cell. */
	onSaveAside: (question: string, answer: string) => void;
	running: boolean;
	/** The ask streaming under this cell right now, if any. */
	asking?: { question: string; text: string } | null;
	/** Agent cells: the answer streaming in right now. */
	streaming?: string | null;
	/** The learning bar: rating, cross-check, graph. */
	onRate: (level: import("@/src/core").UnderstandingLevel | null) => void;
	onExtract: () => void;
	extracting: boolean;
	onJournal: (j: import("@/src/core").Journal) => void;
	/** The notebook's undo/redo — reached from edit mode once the text box's own history is empty. */
	onHistory: (direction: "undo" | "redo") => void;
}

/**
 * Replace [a, b) of the text box through the browser's own editing path, so
 * Ctrl/⌘+Z undoes it like typing. False when the browser refuses
 * (execCommand unsupported) — the caller then sets the value itself.
 */
function editText(el: HTMLTextAreaElement, a: number, b: number, text: string): boolean {
	el.focus();
	el.setSelectionRange(a, b);
	try {
		return document.execCommand("insertText", false, text);
	} catch {
		return false;
	}
}

export function JournalCellView({
	journalId,
	cell,
	index,
	count,
	editing,
	onEdit,
	onDone,
	onCommit,
	onAddBelow,
	onMove,
	onDelete,
	onRun,
	onAsk,
	onSaveAside,
	onFlashcards,
	running,
	asking,
	streaming,
	onRate,
	onExtract,
	extracting,
	onJournal,
	onHistory,
}: JournalCellProps) {
	const [source, setSource] = useState(cell.source);
	const [lang, setLang] = useState(cell.lang ?? "");
	const [output, setOutput] = useState(cell.output ?? "");
	const rootRef = useRef<HTMLDivElement>(null);
	const sourceRef = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const [uploading, setUploading] = useState(0);
	const [uploadError, setUploadError] = useState<string | null>(null);

	/** Upload files and insert their embeds at the caret, each on its own line. */
	const attach = async (files: File[]) => {
		const media = files.filter((f) => isMediaName(f.name) || /^(image|video)\//.test(f.type));
		if (media.length === 0) return;
		setUploadError(null);
		setUploading((n) => n + media.length);
		const el = sourceRef.current;
		let at = el ? el.selectionStart : source.length;
		for (const file of media) {
			// Pasted screenshots arrive as "image.png" — name them by time.
			const named = isMediaName(file.name) ? file : new File([file], `pasted-${Date.now()}.${file.type.split("/")[1] || "png"}`, { type: file.type });
			try {
				const { markdown } = await journalApi.uploadMedia(journalId, named);
				const box = sourceRef.current;
				const current = box?.value ?? source;
				const before = current.slice(0, at);
				const insert = `${before && !before.endsWith("\n") ? "\n" : ""}${markdown}\n`;
				if (!(box && editText(box, before.length, before.length, insert))) {
					setSource((prev) => `${prev.slice(0, before.length)}${insert}${prev.slice(before.length)}`);
				}
				at = before.length + insert.length;
			} catch (err) {
				setUploadError(err instanceof Error ? err.message : String(err));
			} finally {
				setUploading((n) => n - 1);
			}
		}
	};

	// Adopt server truth only while NOT editing (the draft is the learner's).
	useEffect(() => {
		if (editing) {
			// A box opened on the rendered cell has no place in the editor.
			setInline((box) => (box && box.insertAt === undefined ? null : box));
			return;
		}
		setInline(null);
		setSource(cell.source);
		setLang(cell.lang ?? "");
		setOutput(cell.output ?? "");
	}, [editing, cell.source, cell.lang, cell.output]);

	useEffect(() => {
		if (!editing) return;
		const el = sourceRef.current;
		if (!el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
	}, [editing]);

	const isCode = cell.role === "code";
	const isAgent = cell.role === "agent";
	/** Markdown-type cells take image / video embeds. */
	const takesMedia = !isCode && !isAgent;
	const canRun = (isCode && runnableLang(cell.lang) !== null) || isAgent;
	const draftRunnable = (isCode && runnableLang(lang) !== null) || isAgent;

	/**
	 * Save the draft (minus `/ask` lines), leave edit mode, then — in order —
	 * run (when asked to and the cell can), ask each lifted question (so the
	 * answer sees the fresh output), and open a new cell for Shift+Enter.
	 */
	const commit = async (mode: "render" | "run" | "runNext") => {
		const { questions, source: clean } = extractCellAsks(source);
		if (questions.length) setSource(clean);
		const patch: CellPatch = {};
		if (clean !== cell.source) patch.source = clean;
		if (isCode) {
			if (lang !== (cell.lang ?? "")) patch.lang = lang;
			if (output !== (cell.output ?? "")) patch.output = output;
		}
		if (Object.keys(patch).length > 0) await onCommit(patch);
		onDone();
		const run = mode !== "render" && draftRunnable && clean.trim() !== "";
		const work = (async () => {
			if (run) await onRun();
			for (const q of questions) await onAsk(q);
		})();
		if (mode === "runNext") onAddBelow();
		else rootRef.current?.focus();
		await work;
	};

	// ── Inline ask (Mod+L, then I / E / anything) ─────────────────────────────
	const [inline, setInline] = useState<InlineAskRequest | null>(null);
	/** A started Mod+L chord: the selection it captured + its timeout. */
	const chordRef = useRef<{ selection: string; insertAt: number; timer: ReturnType<typeof setTimeout> } | null>(null);
	const [chordHint, setChordHint] = useState(false);
	const nonceRef = useRef(0);

	const openInline = (mode: InlineAskRequest["mode"], initial?: string) => {
		const chord = chordRef.current;
		if (!chord) return;
		clearTimeout(chord.timer);
		chordRef.current = null;
		setChordHint(false);
		setInline({ mode, selection: chord.selection, insertAt: chord.insertAt, nonce: ++nonceRef.current, ...(initial ? { initial } : {}) });
	};

	const startChord = () => {
		const el = sourceRef.current;
		if (!el) return;
		let { selectionStart: a, selectionEnd: b } = el;
		if (a === b) {
			// Nothing highlighted: the caret's line.
			a = source.lastIndexOf("\n", a - 1) + 1;
			const nl = source.indexOf("\n", b);
			b = nl < 0 ? source.length : nl;
		}
		if (chordRef.current) clearTimeout(chordRef.current.timer);
		chordRef.current = { selection: source.slice(a, b), insertAt: b, timer: setTimeout(() => openInline("ask"), 1500) };
		setChordHint(true);
	};

	/** The chord's second key: the bare binding, or the same key with Mod held. */
	const chordKeyIs = (native: KeyboardEvent, id: "journal-inline-insert" | "journal-inline-explain") => {
		const binding = bindingForAction(id);
		const pressed = eventBinding(native);
		return pressed === binding || pressed === `mod+${binding}`;
	};

	/** Insert text into the draft at `at` (own line after a highlighted passage). */
	const insertAnswer = (text: string, at: number) => {
		setInline(null);
		if (!text.trim()) return;
		const before = source.slice(0, at);
		const sep = before && !before.endsWith("\n") ? "\n" : "";
		const box = sourceRef.current;
		if (box && editText(box, at, at, sep + text)) {
			box.setSelectionRange(at + sep.length, at + sep.length + text.length);
			return;
		}
		setSource(`${before}${sep}${text}${source.slice(at)}`);
		requestAnimationFrame(() => {
			const el = sourceRef.current;
			if (!el) return;
			el.focus();
			el.setSelectionRange(at + sep.length, at + sep.length + text.length);
		});
	};

	// ── Ask about text highlighted in the rendered cell ───────────────────────
	/** Where the Ask / Explain buttons float (viewport px), while a highlight stands. */
	const [picked, setPicked] = useState<{ x: number; y: number } | null>(null);

	const askSelection = (mode: InlineAskMode) => {
		const sel = selectedCellText();
		setPicked(null);
		if (!sel || sel.cell !== rootRef.current) return;
		window.getSelection()?.removeAllRanges();
		setInline({ mode, selection: sel.text, nonce: ++nonceRef.current });
	};
	const askSelectionRef = useRef(askSelection);
	askSelectionRef.current = askSelection;

	useEffect(() => {
		if (editing) {
			setPicked(null);
			return;
		}
		const place = () => {
			const sel = selectedCellText();
			if (!sel || sel.cell !== rootRef.current) {
				setPicked(null);
				return;
			}
			const rect = Array.from(sel.range.getClientRects()).at(-1) ?? sel.range.getBoundingClientRect();
			setPicked({ x: Math.max(8, Math.min(rect.right - 60, window.innerWidth - 180)), y: Math.min(rect.bottom + 6, window.innerHeight - 40) });
		};
		// Only once the highlight has settled (mouse released / a shift-arrow step).
		const onUp = () => setTimeout(place, 0);
		const onChange = () => {
			if (!selectedCellText()) setPicked(null);
		};
		const hide = () => setPicked(null);
		const onAsk = (e: Event) => {
			const { cellId, mode } = (e as CustomEvent<{ cellId: string; mode: InlineAskMode }>).detail;
			if (cellId === cell.id) askSelectionRef.current(mode);
		};
		document.addEventListener("mouseup", onUp);
		document.addEventListener("keyup", onUp);
		document.addEventListener("selectionchange", onChange);
		window.addEventListener("scroll", hide, true);
		window.addEventListener(JOURNAL_ASK_SELECTION_EVENT, onAsk);
		return () => {
			document.removeEventListener("mouseup", onUp);
			document.removeEventListener("keyup", onUp);
			document.removeEventListener("selectionchange", onChange);
			window.removeEventListener("scroll", hide, true);
			window.removeEventListener(JOURNAL_ASK_SELECTION_EVENT, onAsk);
		};
	}, [editing, cell.id]);

	const inlineBox = inline && (
		<InlineAskBox
			journalId={journalId}
			cell={cell}
			lang={lang}
			draft={source}
			request={inline}
			onInsert={insertAnswer}
			onSave={(question, answer) => {
				setInline(null);
				onSaveAside(question, answer);
				requestAnimationFrame(() => (editing ? sourceRef.current : rootRef.current)?.focus({ preventScroll: true }));
			}}
			onClose={() => {
				setInline(null);
				requestAnimationFrame(() => (editing ? sourceRef.current : rootRef.current)?.focus({ preventScroll: true }));
			}}
		/>
	);

	// Edit-mode keys come from the registry (Settings → Keyboard rebinds them).
	const onKeyDown = (e: React.KeyboardEvent) => {
		const native = e.nativeEvent;
		const claim = () => {
			e.preventDefault();
			e.stopPropagation();
		};
		if (chordRef.current) {
			// Second key of Mod+L: I insert · E explain · Esc cancel · else ask.
			if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
			claim();
			if (chordKeyIs(native, "journal-inline-insert")) openInline("insert");
			else if (chordKeyIs(native, "journal-inline-explain")) openInline("explain");
			else if (e.key === "Escape") {
				clearTimeout(chordRef.current.timer);
				chordRef.current = null;
				setChordHint(false);
			} else openInline("ask", e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : undefined);
			return;
		}
		if (eventMatchesAction(native, "journal-inline") && e.target === sourceRef.current) {
			claim();
			startChord();
			return;
		}
		if (eventMatchesAction(native, "journal-exit-cell")) {
			claim();
			void commit("render");
		} else if (eventMatchesAction(native, "journal-run-cell")) {
			claim();
			void commit("run");
		} else if (eventMatchesAction(native, "journal-run-next")) {
			claim();
			void commit("runNext");
		} else if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && isCode && e.target === sourceRef.current) {
			// Tab indents code (4 spaces) instead of leaving the field.
			claim();
			const el = sourceRef.current!;
			const { selectionStart: a, selectionEnd: b } = el;
			if (editText(el, a, b, "    ")) return;
			setSource(`${source.slice(0, a)}    ${source.slice(b)}`);
			requestAnimationFrame(() => el.setSelectionRange(a + 4, a + 4));
		} else if (e.target === sourceRef.current && (eventMatchesAction(native, "journal-undo") || eventMatchesAction(native, "journal-redo"))) {
			// The text box's own history first; when it has nothing left, the
			// key leaves the cell and steps the notebook's history instead.
			// The browser's undo stack is page-wide (queryCommandEnabled stays
			// true from other, unmounted boxes), so let it try and watch: only a
			// history input event proves it did something.
			const direction = eventMatchesAction(native, "journal-undo") ? "undo" : "redo";
			let handled = false;
			const seen = (ev: Event) => {
				if ((ev as InputEvent).inputType?.startsWith("history")) handled = true;
			};
			document.addEventListener("input", seen, true);
			setTimeout(() => {
				document.removeEventListener("input", seen, true);
				if (!handled) void commit("render").then(() => onHistory(direction));
			}, 0);
		}
	};

	// Click-away commits (focus leaving the cell's own controls).
	const onBlur = (e: React.FocusEvent) => {
		if (!editing) return;
		if (rootRef.current?.contains(e.relatedTarget as Node | null)) return;
		// A hop to the scratchpad (Mod+P) is not leaving the cell: the draft
		// stays open and focus comes back when the pad hides.
		if ((e.relatedTarget as Element | null)?.closest?.("[data-scratchpad]")) return;
		void commit("render");
	};

	const rendered = isCode ? (cell.source.trim() ? fenced(cell.source, cell.lang || "text") : "") : cell.source;
	const renderedOutput = isCode && cell.output?.trim() ? fenced(cell.output, "text") : "";
	/** Agent cells: the answer (streaming, else the saved one) as markdown. */
	const agentAnswer = isAgent ? (streaming ?? cell.output ?? "") : "";

	return (
		<div
			ref={rootRef}
			tabIndex={-1}
			id={`cell-${cell.id}`}
			data-testid="journal-cell"
			data-cell-id={cell.id}
			data-role={cell.role}
			onBlur={onBlur}
			onKeyDown={(e) => {
				if (!editing && e.target === rootRef.current && eventMatchesAction(e.nativeEvent, "journal-edit-cell")) {
					e.preventDefault();
					e.stopPropagation();
					onEdit();
				}
			}}
			className={cn(
				"group relative rounded-lg px-3 py-2 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
				editing ? "bg-accent/40" : "hover:bg-accent/20",
				!cell.publish && !editing && "opacity-70",
			)}
		>
			<div className="mb-1 flex select-none items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
				{editing ? (
					<select
						aria-label="Cell role"
						value={cell.role}
						onChange={(e) => void onCommit({ role: e.target.value as JournalCellRole })}
						className="rounded-sm border border-border bg-background px-1 py-0.5 text-[11px] uppercase tracking-wider"
					>
						{JOURNAL_CELL_ROLES.filter((r) => PICKABLE_ROLES.includes(r) || r === cell.role).map((r) => (
							<option key={r} value={r}>
								{ROLE_LABEL[r]}
							</option>
						))}
					</select>
				) : (
					<span>{ROLE_LABEL[cell.role]}</span>
				)}
				{cell.origin && <span className="normal-case tracking-normal text-muted-foreground/60">from session</span>}
				{isCode && !editing && (
					<span className="font-mono normal-case tracking-normal text-muted-foreground/70" data-testid="journal-cell-count">
						{cell.lang || "text"} [{running ? "*" : (cell.executionCount ?? " ")}]
					</span>
				)}
				<span className="flex-1" />
				{canRun && (
					<IconButton label={running ? "Running…" : isAgent ? "Run agent (Ctrl/⌘+Enter)" : "Run cell (Ctrl/⌘+Enter)"} testid="journal-cell-run" disabled={running} onClick={() => void onRun()}>
						{running ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <PlayIcon className="size-3.5 text-primary" />}
					</IconButton>
				)}
				<div className={cn("flex items-center gap-0.5", !editing && "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100")}>
					<IconButton label="Move up" disabled={index === 0} onClick={() => onMove(index - 1)}>
						<ArrowUpIcon className="size-3.5" />
					</IconButton>
					<IconButton label="Move down" disabled={index === count - 1} onClick={() => onMove(index + 1)}>
						<ArrowDownIcon className="size-3.5" />
					</IconButton>
					<IconButton label="Make flashcards from this cell (F)" testid="journal-cell-flashcards" onClick={onFlashcards}>
						<LayersIcon className="size-3.5" />
					</IconButton>
					<IconButton label="Delete cell" onClick={onDelete}>
						<Trash2Icon className="size-3.5" />
					</IconButton>
				</div>
				<IconButton
					label={cell.publish ? "Published — click to keep private" : "Private — click to publish"}
					testid="journal-cell-publish"
					onClick={() => void onCommit({ publish: !cell.publish })}
				>
					{cell.publish ? <EyeIcon className="size-3.5 text-primary" /> : <EyeOffIcon className="size-3.5" />}
				</IconButton>
			</div>

			{editing ? (
				<div className="flex flex-col gap-2" onKeyDown={onKeyDown}>
					{isCode && (
						<>
							<input
								aria-label="Language"
								list="journal-code-langs"
								value={lang}
								onChange={(e) => setLang(e.target.value)}
								placeholder="language (python, cpp, …)"
								className="lh-input w-48 border-0 border-b border-border bg-transparent px-0 font-mono text-xs outline-none"
							/>
							<datalist id="journal-code-langs">
								<option value="python" />
								<option value="cpp" />
							</datalist>
						</>
					)}
					<textarea
						ref={sourceRef}
						aria-label={cell.role === "code" ? "Code" : "Cell text"}
						value={source}
						onChange={(e) => setSource(e.target.value)}
						onPaste={(e) => {
							if (!takesMedia) return;
							const files = [...e.clipboardData.files];
							if (files.length === 0) return;
							e.preventDefault();
							void attach(files);
						}}
						onDragOver={(e) => takesMedia && e.dataTransfer.types.includes("Files") && e.preventDefault()}
						onDrop={(e) => {
							if (!takesMedia || e.dataTransfer.files.length === 0) return;
							e.preventDefault();
							void attach([...e.dataTransfer.files]);
						}}
						placeholder={cell.role === "code" ? "code" : isAgent ? "Ask the agent — e.g. write a C++ version of the cell above" : "Markdown — $math$ welcome"}
						className={cn(
							"field-sizing-content lh-input min-h-16 w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 outline-none",
							cell.role === "code" && "font-mono text-sm",
						)}
					/>
					{chordHint && (
						<div className="text-[11px] text-primary" data-testid="inline-chord-hint">
							Inline ask: <kbd>I</kbd> insert · <kbd>E</kbd> explain · type to ask · Esc cancel
						</div>
					)}
					{inlineBox}
					{isCode && !draftRunnable && (
						<textarea
							aria-label="Recorded output"
							value={output}
							onChange={(e) => setOutput(e.target.value)}
							placeholder="recorded output (optional, pasted — only python and cpp run here)"
							className="field-sizing-content lh-input min-h-10 w-full resize-none rounded-md border border-dashed border-border bg-background px-2.5 py-2 font-mono text-xs outline-none"
						/>
					)}
					{takesMedia && (
						<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
							<button
								type="button"
								data-testid="journal-cell-attach"
								onClick={() => fileRef.current?.click()}
								className="flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
							>
								<PaperclipIcon className="size-3" />
								Image / video
							</button>
							<input
								ref={fileRef}
								type="file"
								multiple
								accept={MEDIA_ACCEPT}
								className="hidden"
								data-testid="journal-cell-file"
								onChange={(e) => {
									const files = [...(e.target.files ?? [])];
									e.target.value = "";
									void attach(files);
								}}
							/>
							<span className="text-muted-foreground/60">or paste / drop into the text</span>
							{uploading > 0 && (
								<span className="flex items-center gap-1">
									<LoaderCircleIcon className="size-3 animate-spin" /> uploading…
								</span>
							)}
							{uploadError && <span className="text-destructive">{uploadError}</span>}
						</div>
					)}
					<div className="text-[11px] text-muted-foreground/70">
						{isAgent
							? "Write a request — Ctrl/⌘+Enter runs the agent with the whole journal as context · Esc to render"
							: draftRunnable
								? "Ctrl/⌘+Enter to run · Shift+Enter run + new cell · Esc to render"
								: "Esc to render · Shift+Enter for a new cell"}
						{!isAgent && (
							<>
								{" · "}
								{isCode ? "# /ask …" : "/ask …"} on its own line asks about this cell
							</>
						)}
					</div>
				</div>
			) : (
				<div
					data-ask-scope
					className={cn("cursor-text", ROLE_TONE[cell.role])}
					// A drag that highlighted text is not a click-to-edit.
					onClick={() => !selectedCellText() && onEdit()}
				>
					{rendered.trim() ? (
						takesMedia ? <MarkdownWithMedia text={rendered} journalId={journalId} /> : <MessageResponse>{rendered}</MessageResponse>
					) : (
						<span className="text-sm italic text-muted-foreground/60">Empty — click to write</span>
					)}
				</div>
			)}
			{isAgent && (agentAnswer.trim() || running) && (
				<div data-ask-scope className="mt-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm" data-testid="journal-agent-answer">
					<div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
						<SparklesIcon className="size-3 text-primary" />
						Agent
					</div>
					{agentAnswer.trim() ? <MessageResponse>{agentAnswer}</MessageResponse> : <span className="text-xs italic text-muted-foreground">thinking…</span>}
				</div>
			)}
			{renderedOutput && (
				<div data-ask-scope className="mt-1 border-l-2 border-border pl-2 text-sm" data-testid="journal-cell-output">
					<MessageResponse>{renderedOutput}</MessageResponse>
				</div>
			)}
			{asking && (
				<div className="mt-2 rounded-md border border-dashed border-primary/40 px-3 py-2 text-sm" data-testid="journal-cell-asking">
					<div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
						<SparklesIcon className="size-3 text-primary" />
						/ask {asking.question}
					</div>
					{asking.text ? <MessageResponse>{asking.text}</MessageResponse> : <span className="text-xs italic text-muted-foreground">thinking…</span>}
				</div>
			)}
			{!editing && inlineBox}
			{!editing &&
				picked &&
				createPortal(
					<div
						role="toolbar"
						aria-label="Ask about the highlighted text"
						data-testid="journal-selection-ask"
						className="fixed z-50 flex gap-1"
						style={{ left: picked.x, top: picked.y }}
						// Keep the highlight alive through the click.
						onPointerDown={(e) => e.preventDefault()}
					>
						{(["ask", "explain"] as const).map((mode) => (
							<button
								key={mode}
								type="button"
								data-testid={`journal-selection-${mode}`}
								onClick={() => askSelection(mode)}
								className="flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md transition-colors hover:bg-accent"
							>
								{mode === "ask" && <SparklesIcon className="size-3 text-primary" />}
								{mode === "ask" ? "Ask" : "Explain"}
							</button>
						))}
					</div>,
					document.body,
				)}
			{!editing && (
				<CellLearningBar journalId={journalId} cell={cell} onRate={onRate} onExtract={onExtract} extracting={extracting} onJournal={onJournal} />
			)}
		</div>
	);
}

function IconButton({
	label,
	onClick,
	disabled,
	testid,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	testid?: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			data-testid={testid}
			disabled={disabled}
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
		>
			{children}
		</button>
	);
}
