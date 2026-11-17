"use client";

/**
 * A cell's learning bar (owner, 2026-11-15): the learner's rating (did it
 * on my own / with help / couldn't, even with help), the agent's
 * cross-check of that rating. The graph is per NOTEBOOK (owner,
 * 2026-11-15), so "Add to graph" lives in the notebook header.
 */

import { useEffect, useRef, useState } from "react";
import { LoaderCircleIcon, ShieldQuestionIcon } from "lucide-react";
import {
	RATEABLE_ROLES,
	UNDERSTANDING_LABEL,
	UNDERSTANDING_LEVELS,
	checkDisagrees,
	ratingIsStale,
	type JournalCell,
	type UnderstandingLevel,
} from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { journalApi } from "@/components/journal/journal-api";
import { cn } from "@/lib/utils";

const SHORT: Record<UnderstandingLevel, string> = { own: "On my own", helped: "With help", stuck: "Couldn't, even with help" };
const TONE: Record<UnderstandingLevel, string> = {
	own: "border-success/60 bg-success/10 text-success",
	helped: "border-warning/60 bg-warning/10 text-warning",
	stuck: "border-error/60 bg-error/10 text-error",
};
const VERDICT_TONE = { holds: "text-success", shaky: "text-warning", fails: "text-error" } as const;

export function CellLearningBar({
	journalId,
	cell,
	onRate,
	onJournal,
}: {
	journalId: string;
	cell: JournalCell;
	onRate: (level: UnderstandingLevel | null) => void;
	/** Adopt a journal the check returned. */
	onJournal: (j: import("@/src/core").Journal) => void;
}) {
	const [checkOpen, setCheckOpen] = useState(false);
	const rateable = RATEABLE_ROLES.includes(cell.role);
	if (!rateable) return null;

	const u = cell.understanding;
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
						{UNDERSTANDING_LEVELS.map((level, i) => (
							<button
								key={level}
								type="button"
								data-testid={`rate-${level}`}
								aria-pressed={u?.level === level}
								title={`${UNDERSTANDING_LABEL[level]} (${i + 1})`}
								onClick={() => onRate(u?.level === level ? null : level)}
								className={cn(
									"rounded-full border px-2 py-0.5 transition-colors",
									u?.level === level ? TONE[level] : "border-border/70 hover:border-border hover:text-foreground",
									u?.level === level && stale && "opacity-60",
								)}
							>
								{SHORT[level]}
							</button>
						))}
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
