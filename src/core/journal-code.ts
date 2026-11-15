/**
 * Runnable journal cells + cell `/ask` (owner, 2026-11-15 — reverses D8:
 * code cells now execute). Pure: language names, `/ask` extraction, and the
 * prompt that lets the model see a whole cell — source, language, last
 * output — plus the journal around it.
 */

import type { Journal, JournalCell } from "./contracts/journal.ts";

/** Languages the app can run. */
export type RunnableLang = "python" | "cpp";

const LANG_ALIASES: Readonly<Record<string, RunnableLang>> = {
	python: "python",
	python3: "python",
	py: "python",
	cpp: "cpp",
	"c++": "cpp",
	cxx: "cpp",
	cc: "cpp",
};

/** "py", "Python3", "c++" → the runnable language, or null when the app cannot run it. */
export function runnableLang(lang: string | undefined): RunnableLang | null {
	return LANG_ALIASES[(lang ?? "").trim().toLowerCase()] ?? null;
}

/** A cell line `/ask <question>` (code cells may comment it: `# /ask …`, `// /ask …`). */
const CELL_ASK_RE = /^[ \t]*(?:(?:#|\/\/)[ \t]*)?\/ask[ \t]+(\S.*?)[ \t]*$/;

/** Split `/ask` lines out of a cell's text: the questions, and the source without them. */
export function extractCellAsks(source: string): { questions: string[]; source: string } {
	const questions: string[] = [];
	const kept: string[] = [];
	for (const line of source.split("\n")) {
		const m = line.match(CELL_ASK_RE);
		if (m) questions.push(m[1]!);
		else kept.push(line);
	}
	if (questions.length === 0) return { questions, source };
	return { questions, source: kept.join("\n").replace(/\n+$/, "") };
}

export const JOURNAL_ASK_SYSTEM_PROMPT = `You answer a question a learner asked about one cell of their notebook-style learning journal. Cells are markdown notes, code (Python or C++) with its last run output, and practice exercises.

- Ground the answer in the FOCUS CELL: its full text, its code and its output. Use the other cells as context.
- When the output shows an error, explain the cause and show the fix.
- Correct misconceptions plainly. Be concise: a short paragraph, a few bullets, or a short code block; go longer only when the question needs it.
- Markdown is fine; math as $…$ / $$…$$. No headings.
- End with at most one short follow-up question that would push their understanding, prefixed "→ ".`;

/** Bound on the prompt's surrounding-cell text; the focus cell is never cut. */
const CONTEXT_BUDGET = 40_000;
const OUTPUT_CAP = 8_000;

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

function cellBlock(cell: JournalCell, label: string, outputCap: number): string {
	const head = `[${label}] ${cell.role}${cell.role === "code" ? ` (${cell.lang || "text"})` : ""}`;
	const parts = [head, cell.source.trim() ? `"""\n${cell.source}\n"""` : "(empty)"];
	if (cell.role === "code" && cell.output?.trim()) {
		parts.push(`Output${cell.executionCount ? ` [${cell.executionCount}]` : ""}:\n"""\n${clip(cell.output, outputCap)}\n"""`);
	}
	return parts.join("\n");
}

function cellIndex(journal: Journal, cellId: string): number {
	const at = journal.cells.findIndex((c) => c.id === cellId);
	if (at < 0) throw new Error(`No cell [${cellId}] in journal [${journal.id}].`);
	return at;
}

/** The cells around index `at`, nearest first under the budget. */
function contextAround(journal: Journal, at: number): { before: string[]; after: string[] } {
	const before: string[] = [];
	const after: string[] = [];
	let budget = CONTEXT_BUDGET;
	// Walk outward from the focus cell so the closest context survives the budget.
	for (let d = 1; d < journal.cells.length && budget > 0; d++) {
		for (const i of [at - d, at + d]) {
			const cell = journal.cells[i];
			if (!cell) continue;
			const block = cellBlock(cell, `cell ${i + 1}`, 2_000);
			if (block.length > budget) {
				budget = 0;
				break;
			}
			budget -= block.length;
			if (i < at) before.unshift(block);
			else after.push(block);
		}
	}
	return { before, after };
}

/** The user message for a cell `/ask`. Nearby cells win when the journal is long. */
export function journalAskPrompt(journal: Journal, cellId: string, question: string): string {
	const at = cellIndex(journal, cellId);
	const focus = cellBlock(journal.cells[at]!, "FOCUS CELL", OUTPUT_CAP * 4);
	const { before, after } = contextAround(journal, at);
	return [
		`Journal: ${journal.title}`,
		before.length ? `Cells before the focus cell:\n\n${before.join("\n\n")}` : "",
		focus,
		after.length ? `Cells after the focus cell:\n\n${after.join("\n\n")}` : "",
		`Question about the focus cell: ${question}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** The aside cell that records an answer. */
export function askAnswerCell(question: string, answer: string): string {
	return `**/ask** ${question}\n\n${answer.trim()}`;
}

export const JOURNAL_AGENT_SYSTEM_PROMPT = `You are the agent inside a learner's notebook-style learning journal. The learner wrote a request in an agent cell; your answer is shown as that cell's output, right where the cell sits in the notebook.

- Do what the request asks, using the notebook (markdown notes, Python / C++ code cells with their last outputs) as context.
- When you write code, write it for the notebook's own languages (Python or C++), in fenced blocks with the language, ready to paste into a code cell.
- Be direct and concise; go longer only when the request needs it. Markdown is fine; math as $…$ / $$…$$. No top-level headings.`;

/** The user message for running an agent cell: the notebook around it + its request. */
export function journalAgentPrompt(journal: Journal, cellId: string): string {
	const at = cellIndex(journal, cellId);
	const { before, after } = contextAround(journal, at);
	return [
		`Journal: ${journal.title}`,
		before.length ? `Cells above the agent cell:\n\n${before.join("\n\n")}` : "",
		after.length ? `Cells below the agent cell:\n\n${after.join("\n\n")}` : "",
		`Request (agent cell ${at + 1}):\n\"\"\"\n${journal.cells[at]!.source.trim()}\n\"\"\"`,
	]
		.filter(Boolean)
		.join("\n\n");
}

// ─── Inline ask while editing (owner, 2026-11-15) ───────────────────────────
// Ctrl+L in a cell being edited: E explains the highlighted text in a small
// box (follow-ups chat there); I inserts an answer into the cell; any other
// key opens the box for a free question. Nothing is saved server-side.

export type InlineAskMode = "explain" | "insert" | "ask";

export interface InlineAskInput {
	mode: InlineAskMode;
	/** The cell's text as it stands in the editor (unsaved draft). */
	draft: string;
	role: JournalCell["role"];
	lang?: string;
	/** The highlighted text (or the caret's line when nothing is selected). */
	selection: string;
	/** Earlier turns in the box, oldest first; the last user turn is the question. */
	turns: Array<{ role: "user" | "assistant"; text: string }>;
}

export const INLINE_EXPLAIN_SYSTEM_PROMPT = `You explain a passage the learner highlighted while writing in their notebook. Your answer appears in a small popup next to the text, so:

- Explain exactly the highlighted passage, in the context of the cell and notebook around it. Correct it plainly if it is wrong.
- Short: 2–5 sentences or a few bullets; a tiny example only if it makes the point land. Markdown is fine; math as $…$.
- No preamble, no headings, no follow-up questions.`;

export const INLINE_INSERT_SYSTEM_PROMPT = `You write text that will be inserted directly into the learner's notebook cell, right after the highlighted passage. The highlighted passage is a request, question, or stub to complete.

- Output ONLY the text to insert — no preamble, no "Here is", no closing remarks.
- In a code cell, output only code in the cell's language (comments allowed), with no markdown fences.
- In a markdown cell, output markdown that reads as part of the note (math as $…$). Concise.`;

/** The user message for an inline ask (focus = the live draft of the cell). */
export function inlineAskPrompt(journal: Journal, cellId: string, input: InlineAskInput): string {
	const at = cellIndex(journal, cellId);
	const { before, after } = contextAround(journal, at);
	const kind = input.role === "code" ? `code (${input.lang || "text"})` : input.role === "reflection" ? "markdown" : input.role;
	const lastUser = [...input.turns].reverse().find((t) => t.role === "user")?.text.trim();
	const history = input.turns.slice(0, -1).filter((t) => t.text.trim());
	const task =
		input.mode === "insert"
			? `Write what to insert right after the highlighted passage${lastUser ? `, following this instruction: ${lastUser}` : ""}.`
			: input.mode === "explain" && !lastUser
				? "Explain the highlighted passage."
				: `Question about the highlighted passage: ${lastUser ?? "Explain it."}`;
	return [
		`Notebook: ${journal.title}`,
		before.length ? `Cells above:\n\n${before.join("\n\n")}` : "",
		`[THE CELL BEING EDITED] ${kind}\n"""\n${clip(input.draft, OUTPUT_CAP * 4)}\n"""`,
		after.length ? `Cells below:\n\n${after.join("\n\n")}` : "",
		`Highlighted passage:\n"""\n${clip(input.selection, OUTPUT_CAP)}\n"""`,
		history.length ? `Earlier in this popup:\n\n${history.map((t) => `${t.role === "user" ? "Learner" : "You"}: ${t.text.trim()}`).join("\n\n")}` : "",
		task,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** Insert answers in code cells: strip a fence the model added anyway. */
export function unfenceInsert(text: string, role: JournalCell["role"]): string {
	const t = text.trim();
	if (role !== "code") return t;
	const m = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(t);
	return m ? m[1]! : t;
}
