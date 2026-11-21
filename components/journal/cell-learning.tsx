"use client";

/**
 * A cell's learning bar (owner, 2026-11-15): the learner's confidence they
 * understand the cell (owner, 2026-11-21: the quiz dock's 0–100 slider,
 * replacing on my own / with help / couldn't), the agent's cross-check of
 * that rating. 0% = couldn't understand → prerequisites get explained. The graph is per NOTEBOOK (owner,
 * 2026-11-15), so "Add to graph" lives in the notebook header.
 */

import { useEffect, useRef, useState } from "react";
import { LoaderCircleIcon, ShieldQuestionIcon } from "lucide-react";
import {
	CONFIDENCE_STOPS,
	RATEABLE_ROLES,
	cellConfidence,
	checkDisagrees,
	ratingIsStale,
	snapConfidence,
	type JournalCell,
} from "@/src/core";
import { CONFIDENCE_COLORS, confidenceRailStyle } from "@/components/confidence-rail";
import { MessageResponse } from "@/components/ai-elements/message";
import { journalApi } from "@/components/journal/journal-api";
import { cn } from "@/lib/utils";

/** Commit a dragged value once the slider rests (one save per gesture). */
const COMMIT_MS = 350;
const VERDICT_TONE = { holds: "text-success", shaky: "text-warning", fails: "text-error" } as const;

export function CellLearningBar({
	journalId,
	cell,
	onRate,
	onJournal,
}: {
	journalId: string;
	cell: JournalCell;
	/** Confidence 0–100 (null clears). */
	onRate: (confidence: number | null) => void;
	/** Adopt a journal the check returned. */
	onJournal: (j: import("@/src/core").Journal) => void;
}) {
	const [checkOpen, setCheckOpen] = useState(false);
	const u = cell.understanding;
	const saved = u ? cellConfidence(u) : null;
	// The slider's live value while dragging; follows the saved one otherwise.
	const [draft, setDraft] = useState<number | null>(saved);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => setDraft(saved), [saved]);
	useEffect(() => () => {
		if (timer.current) clearTimeout(timer.current);
	}, []);
	if (!RATEABLE_ROLES.includes(cell.role)) return null;
	const change = (v: number) => {
		setDraft(v);
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => v !== saved && onRate(v), COMMIT_MS);
	};
	const shown = draft ?? 50;
	const color = draft === null ? undefined : CONFIDENCE_COLORS[CONFIDENCE_STOPS.indexOf(shown)];

	const stale = ratingIsStale(cell);
	const mismatch = u?.check && checkDisagrees(u.level, u.check.verdict);
	const quiet = !u && !checkOpen;

	return (
		<div
			className={cn("mt-1.5 flex flex-col gap-1.5", quiet && "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100")}
			data-testid="cell-learning"
			onClick={(e) => e.stopPropagation()}
		>
			<div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
				<>
						<span className="shrink-0 uppercase tracking-wide">Confidence</span>
						<div className={cn("relative h-4 w-40 sm:w-56", draft === null && "opacity-50 hover:opacity-80")} data-testid="cell-confidence-track">
							<div
								aria-hidden
								className="pointer-events-none absolute top-1/2 left-2 right-2 h-1.5 -translate-y-1/2 rounded-full border border-border"
								style={confidenceRailStyle(draft === null ? 0 : shown)}
							/>
							<input
								type="range"
								min={0}
								max={100}
								step={1}
								value={shown}
								aria-label="Confidence that you understand this cell"
								aria-valuetext={draft === null ? "not rated" : `${shown} percent`}
								title="How sure are you that you understand this cell? 0% explains the prerequisites. ←/→ on a focused cell."
								data-testid="cell-confidence"
								// Unrated: the first click on the rail rates it, even at the resting 50.
								onPointerDown={() => draft === null && change(50)}
								onChange={(e) => change(snapConfidence(Number(e.target.value)))}
								// The notebook's ←/→ owns stepping on a focused cell; on the slider itself too.
								onKeyDown={(e) => (e.key === "ArrowLeft" || e.key === "ArrowRight") && e.preventDefault()}
								style={{ color: color ?? "var(--muted-foreground)" }}
								className={cn(
									"absolute inset-0 h-4 w-full cursor-pointer appearance-none bg-transparent outline-none",
									"[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent",
									"[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current",
									"[&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent",
									"[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-current",
								)}
							/>
						</div>
						<span data-testid="cell-confidence-value" className={cn("w-9 shrink-0 text-right font-mono tabular-nums", stale && "opacity-60")} style={{ color }}>
							{draft === null ? "—" : `${shown}%`}
						</span>
						{u && (
							<button type="button" data-testid="cell-confidence-clear" onClick={() => onRate(null)} title="Clear the rating" className="rounded px-1 hover:bg-accent hover:text-foreground">
								clear
							</button>
						)}
						{u && stale && <span className="italic">text changed since you rated it</span>}
						{u && (
							<button
								type="button"
								data-testid="cell-check"
								onClick={() => setCheckOpen((o) => !o)}
								title="The agent asks one question to cross-check your rating"
								className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
							>
								<ShieldQuestionIcon className="size-3" />
								{u.check ? (
									<span className={VERDICT_TONE[u.check.verdict]}>check: {u.check.verdict}</span>
								) : (
									"Check me"
								)}
							</button>
						)}
						{mismatch && <span className="text-error">the check disagrees with your rating</span>}
				</>
			</div>
			{checkOpen && u && <CheckBox journalId={journalId} cell={cell} onJournal={onJournal} onClose={() => setCheckOpen(false)} />}
		</div>
	);
}

/** The cross-check: the agent's question streams in; the learner answers; a verdict comes back. */
function CheckBox({
	journalId,
	cell,
	onJournal,
	onClose,
}: {
	journalId: string;
	cell: JournalCell;
	onJournal: (j: import("@/src/core").Journal) => void;
	onClose: () => void;
}) {
	const prior = cell.understanding?.check;
	const [question, setQuestion] = useState("");
	const [asking, setAsking] = useState(false);
	const [answer, setAnswer] = useState("");
	const [grading, setGrading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showPrior, setShowPrior] = useState(Boolean(prior));
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const ask = async () => {
		setShowPrior(false);
		setError(null);
		setQuestion("");
		setAnswer("");
		setAsking(true);
		try {
			const q = await journalApi.checkQuestion(journalId, cell.id, setQuestion);
			setQuestion(q.trim());
			requestAnimationFrame(() => inputRef.current?.focus());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setAsking(false);
		}
	};

	useEffect(() => {
		// Once per open: a cell with an earlier check shows it first.
		if (!prior) void ask();
	}, []);

	const grade = async () => {
		if (!answer.trim() || !question.trim()) return;
		setGrading(true);
		setError(null);
		try {
			const { journal } = await journalApi.checkGrade(journalId, cell.id, question, answer);
			onJournal(journal);
			setShowPrior(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setGrading(false);
		}
	};

	const check = cell.understanding?.check;
	return (
		<div
			className="rounded-md border border-border bg-card px-3 py-2 text-sm"
			data-testid="cell-check-box"
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === "Escape") {
					e.preventDefault();
					onClose();
				}
			}}
		>
			{showPrior && check ? (
				<div className="flex flex-col gap-1.5">
					<div className="text-xs text-muted-foreground">Q: {check.question}</div>
					<div className="text-xs">A: {check.answer}</div>
					<div data-testid="cell-check-verdict">
						<span className={cn("font-medium", VERDICT_TONE[check.verdict])}>{check.verdict}</span>
						<MessageResponse>{check.rationale}</MessageResponse>
					</div>
					<div className="flex gap-2 text-[11px]">
						<button type="button" onClick={() => void ask()} className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
							Ask another
						</button>
						<button type="button" onClick={onClose} className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
							Close
						</button>
					</div>
				</div>
			) : (
				<div className="flex flex-col gap-2">
					<div className="text-xs text-muted-foreground" data-testid="cell-check-question">
						{question ? <MessageResponse>{question}</MessageResponse> : asking ? "Thinking of a question…" : null}
					</div>
					{question && !asking && (
						<>
							<textarea
								ref={inputRef}
								value={answer}
								data-testid="cell-check-answer"
								onChange={(e) => setAnswer(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
										e.preventDefault();
										void grade();
									}
								}}
								placeholder="Your answer — Ctrl/⌘+Enter to submit"
								className="field-sizing-content lh-input min-h-14 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none"
							/>
							<div className="flex items-center gap-2 text-[11px]">
								<button
									type="button"
									data-testid="cell-check-submit"
									disabled={grading || !answer.trim()}
									onClick={() => void grade()}
									className="flex items-center gap-1 rounded border border-border px-2 py-0.5 hover:bg-accent disabled:opacity-50"
								>
									{grading && <LoaderCircleIcon className="size-3 animate-spin" />}
									Submit
								</button>
								<button type="button" onClick={onClose} className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
									Cancel
								</button>
							</div>
						</>
					)}
				</div>
			)}
			{error && <p className="mt-1 text-xs text-destructive">{error}</p>}
		</div>
	);
}
