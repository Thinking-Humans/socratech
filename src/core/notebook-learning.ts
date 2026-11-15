/**
 * Notebooks as the unit of learning (owner, 2026-11-15): per-cell ratings,
 * the agent's cross-check, per-cell graph extraction, and prerequisite
 * help for a cell the learner couldn't understand. Pure.
 *
 * Graph identity: every extracted cell is its own notes source
 * (`notebook://<journalId>/<cellId>`), so re-extracting an EDITED cell
 * withdraws exactly that cell's earlier contribution (ideas only it
 * supported die; shared ideas keep their other provenance) and reads the
 * new text. Extraction runs only when called for a cell or on publish.
 */

import type { Journal, JournalCell, UnderstandingCheck, UnderstandingLevel } from "./contracts/journal.ts";
import { mediaEmbedLine } from "./journal-media.ts";

export const UNDERSTANDING_LABEL: Readonly<Record<UnderstandingLevel, string>> = {
	own: "Did it on my own",
	helped: "Did it with help",
	stuck: "Couldn't understand, even with help",
};

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

/** none = never extracted · current = graph has this text · stale = edited since. */
export function cellGraphStatus(cell: JournalCell): "none" | "current" | "stale" {
	if (!cell.graph) return "none";
	const text = extractableText(cell);
	return text !== null && textHash(text) === cell.graph.hash ? "current" : "stale";
}

/** A rating is stale once the cell's text changed after it was given. */
export function ratingIsStale(cell: JournalCell): boolean {
	return cell.understanding !== undefined && cell.understanding.hash !== textHash(cell.source);
}

/** The notes-source path that identifies one cell in the graph. */
export function cellSourcePath(journalId: string, cellId: string): string {
	return `notebook://${journalId}/${cellId}`;
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
	const level = journal.cells.find((c) => c.id === cellId)?.understanding?.level;
	return [`Notebook: ${journal.title}`, text, level ? `The learner rated it: ${UNDERSTANDING_LABEL[level]}.` : ""].filter(Boolean).join("\n\n");
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
