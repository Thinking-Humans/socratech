/**
 * Notebooks launched from the graph (owner, 2026-11-15): the notebook is
 * the unit of execution. Pick ideas on the graph (or just type a topic),
 * choose Teach or Practice, and a new notebook opens:
 *
 *   teach     an agent cell that teaches the topic step by step, then an
 *             empty markdown cell for the learner's own words
 *   practice  one exercise cell per picked idea (about three for a bare
 *             topic), each followed by an empty attempt cell
 *
 * The picked ideas only ever appear in cells the graph does NOT read
 * (agent / exercise), so a launched notebook never becomes false
 * provenance for ideas the learner didn't write. Pure.
 */

import type { JournalCellRole } from "./contracts/journal.ts";

export type NotebookLaunchMode = "teach" | "practice";

/** One idea picked on the graph. */
export interface GraphPick {
	id: string;
	name: string;
	statement: string;
}

export interface NotebookLaunchInput {
	mode: NotebookLaunchMode;
	topic: string;
	picks: GraphPick[];
}

/** A cell to create, in order. `run` marks the agent cell the client should start. */
export interface LaunchCell {
	role: JournalCellRole;
	source: string;
	run?: true;
}

const MAX_PICKS = 12;
const MAX_TITLE = 80;

export function launchTitle(topic: string): string {
	const t = topic.replace(/\s+/g, " ").trim();
	return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1).trimEnd()}…` : t;
}

/** The notebook's tags: the picked ideas' names. */
export function launchTags(picks: readonly GraphPick[]): string[] {
	return [...new Set(picks.map((p) => p.name.trim()).filter(Boolean))].slice(0, MAX_PICKS);
}

function ideaList(picks: readonly GraphPick[]): string {
	return picks
		.slice(0, MAX_PICKS)
		.map((p) => `- **${p.name.trim()}**: ${p.statement.trim()}`)
		.join("\n");
}

export const TEACH_MARK = "**Teach me**";

/** The Teach notebook's agent cell. */
export function teachRequest(topic: string, picks: readonly GraphPick[]): string {
	const ideas = picks.length
		? `\n\nIdeas from my graph to build toward:\n${ideaList(picks)}`
		: "";
	return `${TEACH_MARK}: ${topic.trim()}${ideas}\n\nTeach it Socratically, one small step at a time. Start from what I most likely already know, give each step a tiny example, and before each new idea ask me to predict what happens next. End by asking me to explain the whole thing in my own words in the cell below.`;
}

export const PRACTICE_MARK = "**Practice**";

/** Fallback agent cell when exercises can't be generated up front. */
export function practiceRequest(topic: string, picks: readonly GraphPick[]): string {
	const ideas = picks.length ? `\n\nIdeas from my graph:\n${ideaList(picks)}` : "";
	return `${PRACTICE_MARK}: ${topic.trim()}${ideas}\n\nPose ${picks.length ? "one problem per idea" : "three problems"} that make me use these ideas without naming them. Number them. Don't give answers or hints.`;
}

export const PRACTICE_SYSTEM_PROMPT = `You write practice problems for a learner's notebook. Each problem must require the learner to USE an idea without naming it — apply it, predict with it, or explain a small case — and be answerable in a few sentences or a few lines of code. Never include answers, hints, or the idea's name. Reply with ONLY a JSON array: [{"idea": "<idea id or empty>", "exercise": "<markdown problem statement>"}].`;

export function practicePrompt(topic: string, picks: readonly GraphPick[]): string {
	if (!picks.length) return `Topic: ${topic.trim()}\n\nWrite 3 problems, from easier to harder. Use "" for idea.`;
	const ideas = picks
		.slice(0, MAX_PICKS)
		.map((p) => `- id: ${p.id}\n  name: ${p.name.trim()}\n  statement: ${p.statement.trim()}`)
		.join("\n");
	return `Topic: ${topic.trim()}\n\nIdeas (one problem each, in this order):\n${ideas}`;
}

/** The model's reply → exercise statements; null when nothing usable came back. */
export function parsePracticeExercises(reply: string): string[] | null {
	const start = reply.indexOf("[");
	const end = reply.lastIndexOf("]");
	if (start < 0 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(reply.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const exercises = parsed
		.map((item) => (item && typeof item === "object" && typeof (item as { exercise?: unknown }).exercise === "string" ? (item as { exercise: string }).exercise.trim() : ""))
		.filter(Boolean);
	return exercises.length ? exercises.slice(0, MAX_PICKS) : null;
}

/** The cells of a Teach notebook. */
export function teachCells(topic: string, picks: readonly GraphPick[]): LaunchCell[] {
	return [
		{ role: "agent", source: teachRequest(topic, picks), run: true },
		{ role: "reflection", source: "" },
	];
}

/** The cells of a Practice notebook; `exercises` null = the agent-cell fallback. */
export function practiceCells(topic: string, picks: readonly GraphPick[], exercises: string[] | null): LaunchCell[] {
	if (!exercises) return [{ role: "agent", source: practiceRequest(topic, picks), run: true }, { role: "attempt", source: "" }];
	return exercises.flatMap((exercise): LaunchCell[] => [
		{ role: "exercise", source: exercise },
		{ role: "attempt", source: "" },
	]);
}

/** Validate a launch request body. */
export function parseNotebookLaunch(body: unknown): NotebookLaunchInput {
	const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	const mode = b.mode === "practice" ? "practice" : b.mode === "teach" || b.mode === undefined ? "teach" : null;
	if (!mode) throw new Error(`Unknown mode "${String(b.mode)}" — teach or practice.`);
	const topic = typeof b.topic === "string" ? b.topic.trim() : "";
	if (!topic) throw new Error("A topic is required.");
	const raw = Array.isArray(b.propositions) ? b.propositions : [];
	const picks = raw.flatMap((p): GraphPick[] => {
		if (!p || typeof p !== "object") return [];
		const { id, name, statement } = p as Record<string, unknown>;
		return typeof id === "string" && typeof name === "string" && typeof statement === "string" ? [{ id, name, statement }] : [];
	});
	return { mode, topic, picks: picks.slice(0, MAX_PICKS) };
}
