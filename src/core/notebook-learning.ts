/**
 * Notebooks as the unit of learning (owner, 2026-11-15): per-cell ratings,
 * the agent's cross-check, per-cell graph extraction, and prerequisite
 * help for a cell the learner couldn't understand. Pure.
 *
 * Graph identity (owner, 2026-11-15): the NOTEBOOK is the graph's unit.
 * One notebook = one notes source (`notebook://<journalId>`) whose text is
 * every learner-written cell, in order. Re-extracting an edited notebook
 * withdraws its earlier contribution (ideas only it supported die; shared
 * ideas keep their other provenance) and reads the new text. Extraction
 * runs only when asked or on publish. Earlier builds extracted per cell
 * (`notebook://<journalId>/<cellId>`); those sources are withdrawn the
 * first time their notebook is read as a whole.
 */

import type { Journal, JournalCell, UnderstandingCheck, UnderstandingLevel } from "./contracts/journal.ts";
import { mediaEmbedLine } from "./journal-media.ts";
import { CONFIDENCE_STOPS } from "./question-core.ts";

export const UNDERSTANDING_LABEL: Readonly<Record<UnderstandingLevel, string>> = {
	own: "Did it on my own",
	helped: "Did it with help",
	stuck: "Couldn't understand, even with help",
};

// Cell confidence (owner, 2026-11-21): the quiz slider's stops, rated per
// cell. 0% is "couldn't understand it" → prerequisites get explained.

/** Nearest stop to any 0–100 value. */
export function snapConfidence(v: number): number {
	return CONFIDENCE_STOPS.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), 50);
}

export function levelForConfidence(confidence: number): UnderstandingLevel {
	return confidence >= 70 ? "own" : confidence > 0 ? "helped" : "stuck";
}

/** Older level-only ratings, read as confidence. */
const LEVEL_CONFIDENCE: Readonly<Record<UnderstandingLevel, number>> = { own: 90, helped: 50, stuck: 0 };

/** A rating's confidence, old or new. */
export function cellConfidence(u: { level: UnderstandingLevel; confidence?: number }): number {
	return typeof u.confidence === "number" ? snapConfidence(u.confidence) : LEVEL_CONFIDENCE[u.level];
}

/** One step along the stops (←/→); unrated starts from 50. */
export function stepConfidence(current: number | null, dir: -1 | 1): number {
	if (current === null) return 50;
	const i = CONFIDENCE_STOPS.indexOf(snapConfidence(current));
	return CONFIDENCE_STOPS[Math.min(CONFIDENCE_STOPS.length - 1, Math.max(0, i + dir))]!;
}

/** A short, stable fingerprint of a cell's text (cyrb53, hex). Same in the
 *  browser and on the server — it only has to notice edits. */
export function textHash(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Cells the learner writes and rates (agent output and asides are not "doing it"). */
export const RATEABLE_ROLES: readonly JournalCell["role"][] = ["reflection", "code"];

/** Cells whose text is the learner's own writing → graph material. */
export const EXTRACTABLE_ROLES: readonly JournalCell["role"][] = ["reflection", "aside"];

/** The text extraction reads: the cell minus media embeds; null = nothing to read. */
export function extractableText(cell: JournalCell): string | null {
	if (!EXTRACTABLE_ROLES.includes(cell.role)) return null;
	const text = cell.source
		.split("\n")
		.filter((l) => !mediaEmbedLine(l))
		.join("\n")
		.trim();
	return text || null;
}

/** The text a notebook contributes: its learner-written cells, in order; null = nothing to read. */
export function notebookExtractableText(journal: Journal): string | null {
	const parts = journal.cells.map(extractableText).filter((t): t is string => t !== null);
	return parts.length ? parts.join("\n\n") : null;
}

/** none = never extracted · current = graph has this text · stale = edited since. */
export function notebookGraphStatus(journal: Journal): "none" | "current" | "stale" {
	if (!journal.graph) return "none";
	const text = notebookExtractableText(journal);
	return text !== null && textHash(text) === journal.graph.hash ? "current" : "stale";
}

/** A rating is stale once the cell's text changed after it was given. */
export function ratingIsStale(cell: JournalCell): boolean {
	return cell.understanding !== undefined && cell.understanding.hash !== textHash(cell.source);
}

/** The notes-source path that identifies one notebook in the graph. */
export function notebookSourcePath(journalId: string): string {
	return `notebook://${journalId}`;
}

/** Legacy per-cell source path (pre-2026-11-15 builds) — only for withdrawal. */
export function legacyCellSourcePath(journalId: string, cellId: string): string {
	return `notebook://${journalId}/${cellId}`;
}

/** The notebook a graph source path points at (notebook or legacy cell form); null = not a notebook. */
export function parseNotebookSourcePath(filePath: string): { journalId: string; cellId?: string } | null {
	const m = /^notebook:\/\/([^/]+)(?:\/([^/]+))?$/.exec(filePath);
	if (!m) return null;
	return m[2] ? { journalId: m[1]!, cellId: m[2] } : { journalId: m[1]! };
}

/** Where a notebook source opens: the notebook (a legacy cell source lands on its cell). */
export function notebookHref(ref: { journalId: string; cellId?: string }): string {
	return `/notebook/${encodeURIComponent(ref.journalId)}${ref.cellId ? `#cell-${ref.cellId}` : ""}`;
}

// ─── Prerequisites for a "stuck" cell ───────────────────────────────────────

export const PREREQ_MARK = "**Prerequisites**";

/** The agent cell's request, inserted above the stuck cell. */
export function prerequisiteRequest(cellNumber: number): string {
	return `${PREREQ_MARK} for cell ${cellNumber + 1} (the cell right below): I couldn't understand it, even with help. Find the ideas it depends on that I'm most likely missing, and explain them from the ground up — one small step at a time, simplest first, each with a tiny example — ending with how they lead into that cell. Don't re-explain the cell itself.`;
}

/** Is this the prerequisites agent cell for the cell right after it? */
export const isPrerequisiteCell = (cell: JournalCell | undefined) => cell?.role === "agent" && cell.source.startsWith(PREREQ_MARK);

// ─── The agent's cross-check ────────────────────────────────────────────────

export const CHECK_QUESTION_SYSTEM_PROMPT = `You check whether a learner really understands one cell of their notebook. Write ONE question that the learner can answer in a few sentences, which they could only answer well if they understand the cell's core idea — not recall its wording. Prefer "why", "what would change if", or "apply it to this small case". Output only the question.`;

export const CHECK_GRADE_SYSTEM_PROMPT = `You grade a learner's answer to a check question about one cell of their notebook.

Reply in exactly this form:
VERDICT: holds | shaky | fails
<two or three sentences: what the answer shows they understand, and the specific gap if any>

holds = the answer shows the core idea is understood; shaky = partly, with a real gap or confusion; fails = the core idea is missing or wrong.`;

function cellBlockFor(journal: Journal, cellId: string): { at: number; text: string } {
	const at = journal.cells.findIndex((c) => c.id === cellId);
	if (at < 0) throw new Error(`No cell [${cellId}] in journal [${journal.id}].`);
	const cell = journal.cells[at]!;
	const out = cell.role === "code" && cell.output?.trim() ? `\nOutput:\n"""\n${cell.output.slice(0, 4000)}\n"""` : "";
	return { at, text: `Cell ${at + 1} (${cell.role === "reflection" ? "markdown" : cell.role === "code" ? `code, ${cell.lang || "text"}` : cell.role}):\n"""\n${cell.source}\n"""${out}` };
}

export function checkQuestionPrompt(journal: Journal, cellId: string): string {
	const { text } = cellBlockFor(journal, cellId);
	const u = journal.cells.find((c) => c.id === cellId)?.understanding;
	return [`Notebook: ${journal.title}`, text, u ? `The learner's confidence that they understand it: ${cellConfidence(u)}%.` : ""].filter(Boolean).join("\n\n");
}

export function checkGradePrompt(journal: Journal, cellId: string, question: string, answer: string): string {
	const { text } = cellBlockFor(journal, cellId);
	return [`Notebook: ${journal.title}`, text, `Check question:\n${question}`, `Learner's answer:\n"""\n${answer}\n"""`].join("\n\n");
}

/** Parse the grader's reply; a reply without a verdict line reads as "shaky". */
export function parseCheckVerdict(text: string): Pick<UnderstandingCheck, "verdict" | "rationale"> {
	const m = /VERDICT:\s*(holds|shaky|fails)\b/i.exec(text);
	const verdict = (m?.[1]?.toLowerCase() ?? "shaky") as UnderstandingCheck["verdict"];
	const rationale = (m ? text.slice(m.index + m[0].length) : text).trim();
	return { verdict, rationale };
}

/** Does the check disagree with the learner's own rating? */
export function checkDisagrees(level: UnderstandingLevel, verdict: UnderstandingCheck["verdict"]): boolean {
	return (level === "own" && verdict !== "holds") || (level === "stuck" && verdict === "holds");
}
