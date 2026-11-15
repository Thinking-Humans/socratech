"use client";

/**
 * The inline-ask box (owner, 2026-11-15): opened from a cell being edited
 * with Mod+L, then I (insert) / E (explain) / anything else (ask). It sits
 * under the editor, streams the answer about the highlighted passage, and
 * takes follow-up questions like a tiny chat. Insert mode drops the answer
 * into the cell and closes. Nothing is saved; Esc closes and returns to the
 * text.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CornerDownLeftIcon, SparklesIcon, XIcon } from "lucide-react";
import { unfenceInsert, type InlineAskMode, type JournalCell } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { journalApi } from "@/components/journal/journal-api";

export interface InlineAskRequest {
	mode: InlineAskMode;
	selection: string;
	/** Where an insert lands (the selection's end in the draft). */
	insertAt: number;
	/** A key typed to open the box — the question's first character. */
	initial?: string;
	/** Bumps per open, so reopening restarts the box. */
	nonce: number;
}

type Turn = { role: "user" | "assistant"; text: string };

const MODE_LABEL: Record<InlineAskMode, string> = { explain: "Explain", insert: "Insert", ask: "Ask" };

export function InlineAskBox({
	journalId,
	cell,
	lang,
	draft,
	request,
	onInsert,
	onClose,
}: {
	journalId: string;
	cell: Pick<JournalCell, "id" | "role">;
	lang: string;
	/** The live editor text (sent as context). */
	draft: string;
	request: InlineAskRequest;
	onInsert: (text: string, at: number) => void;
	onClose: () => void;
}) {
	const [turns, setTurns] = useState<Turn[]>([]);
	const [streaming, setStreaming] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [input, setInput] = useState(request.initial ?? "");
	const inputRef = useRef<HTMLInputElement>(null);
	const abortRef = useRef<AbortController | null>(null);
	const draftRef = useRef(draft);
	draftRef.current = draft;

	const send = useCallback(
		async (mode: InlineAskMode, history: Turn[]) => {
			abortRef.current?.abort();
			const ctrl = new AbortController();
			abortRef.current = ctrl;
			setError(null);
			setStreaming("");
			try {
				const text = await journalApi.inlineAsk(
					journalId,
					cell.id,
					{ mode, draft: draftRef.current, role: cell.role, ...(lang ? { lang } : {}), selection: request.selection, turns: history },
					(soFar) => setStreaming(soFar),
					ctrl.signal,
				);
				if (ctrl.signal.aborted) return;
				if (mode === "insert") {
					onInsert(unfenceInsert(text, cell.role), request.insertAt);
					return;
				}
				setTurns([...history, { role: "assistant", text }]);
			} catch (err) {
				if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (abortRef.current === ctrl) setStreaming(null);
				requestAnimationFrame(() => inputRef.current?.focus());
			}
		},
		[journalId, cell.id, cell.role, lang, request.selection, request.insertAt, onInsert],
	);

	// Explain / insert start at once; ask waits for the question.
	useEffect(() => {
		setTurns([]);
		setInput(request.initial ?? "");
		if (request.mode === "ask") requestAnimationFrame(() => inputRef.current?.focus());
		else void send(request.mode, []);
		return () => abortRef.current?.abort();
		// Once per open (nonce) — send / onInsert changes must not re-fire it.
	}, [request.nonce]);

	const submit = () => {
		const q = input.trim();
		if (!q || streaming !== null) return;
		const history: Turn[] = [...turns, { role: "user", text: q }];
		setTurns(history);
		setInput("");
		void send(request.mode === "insert" ? "insert" : "ask", history);
	};

	const lastAnswer = [...turns].reverse().find((t) => t.role === "assistant")?.text;
	const quote = request.selection.trim().replace(/\s+/g, " ");

	return (
		<div
			className="rounded-md border border-primary/30 bg-card px-3 py-2 text-sm shadow-sm"
			data-testid="inline-ask"
			// The box owns its keys: nothing reaches the cell's edit handlers.
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === "Escape") {
					e.preventDefault();
					onClose();
				}
			}}
		>
			<div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
				<SparklesIcon className="size-3 text-primary" />
				<span>{MODE_LABEL[request.mode]}</span>
				{quote && <span className="min-w-0 flex-1 truncate font-mono normal-case tracking-normal text-muted-foreground/80">“{quote}”</span>}
				{!quote && <span className="flex-1" />}
				<button type="button" aria-label="Close (Esc)" title="Close (Esc)" onClick={onClose} className="rounded p-0.5 hover:bg-accent hover:text-foreground">
					<XIcon className="size-3" />
				</button>
			</div>
			<div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
				{turns.map((t, i) =>
					t.role === "user" ? (
						<div key={i} className="text-xs text-muted-foreground">
							→ {t.text}
						</div>
					) : (
						<div key={i} data-testid="inline-ask-answer">
							<MessageResponse>{t.text}</MessageResponse>
						</div>
					),
				)}
				{streaming !== null &&
					(streaming ? (
						<div data-testid="inline-ask-streaming" className={request.mode === "insert" ? "font-mono text-xs text-muted-foreground" : undefined}>
							{request.mode === "insert" ? <pre className="whitespace-pre-wrap">{streaming}</pre> : <MessageResponse>{streaming}</MessageResponse>}
						</div>
					) : (
						<span className="text-xs italic text-muted-foreground">thinking…</span>
					))}
				{error && <p className="text-xs text-destructive">{error}</p>}
			</div>
			<div className="mt-2 flex items-center gap-2">
				<input
					ref={inputRef}
					value={input}
					data-testid="inline-ask-input"
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							submit();
						}
					}}
					placeholder={request.mode === "insert" ? "Instruction for what to insert… (Enter)" : turns.length ? "Follow-up… (Enter)" : "Ask about the highlighted text… (Enter)"}
					className="lh-input min-w-0 flex-1 border-0 border-b border-border bg-transparent px-0 text-xs outline-none"
				/>
				{lastAnswer && request.mode !== "insert" && (
					<button
						type="button"
						data-testid="inline-ask-insert"
						onClick={() => onInsert(unfenceInsert(lastAnswer, cell.role), request.insertAt)}
						className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground"
						title="Insert this answer into the cell after the highlighted text"
					>
						<CornerDownLeftIcon className="size-3" />
						Insert
					</button>
				)}
			</div>
		</div>
	);
}
