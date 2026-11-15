/**
 * Web clip (docs/web-clip.md, owner 2026-11-15): a page you are reading
 * becomes a new notebook. Pure: markdown → cell plan, the exercise prompt,
 * and parsing the model's exercises. Browser-safe, no I/O.
 *
 * Clipped cells are private (publish off) — the page's text and code are
 * someone else's; only exercises the model writes publish by default.
 */

import type { JournalCellRole } from "./contracts/journal.ts";

/** One planned cell; `section` ties it to the section an exercise follows. */
export interface ClipCell {
	role: Extract<JournalCellRole, "aside" | "code">;
	source: string;
	lang?: string;
	/** Code cells from a `>>>` session: the printed results, as the cell's output. */
	output?: string;
	/** -1 for the source-link cell. */
	section: number;
}

export interface ClipSection {
	index: number;
	heading: string;
	/** The section's text and code, for the exercise prompt. */
	text: string;
}

export interface ClipPlan {
	cells: ClipCell[];
	sections: ClipSection[];
}

/** A page bigger than this many cells folds its tail into one last cell. */
export const MAX_CLIP_CELLS = 150;
/** Prose longer than this splits at paragraph breaks into several cells. */
export const MAX_PROSE_CELL_CHARS = 4000;
/** Exercise prompt budget per section and overall (characters). */
const SECTION_PROMPT_CHARS = 6000;
const TOTAL_PROMPT_CHARS = 60_000;

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/;
/** `#`/`##` start a section (exercises follow sections). */
const SECTION_HEADING_RE = /^#{1,2}\s+(.+?)\s*#*\s*$/;
/** `###` starts a new cell inside the section. */
const SUBHEADING_RE = /^#{3,6}\s+\S/;
/** Back matter that is not reading: dropped with its section. */
const BACK_MATTER_RE = /^(references|notes and references|external links|further reading|bibliography|citations|footnotes|sources)$/i;

/** Heading chrome sites add: permalink pilcrows, empty anchors, wiki [edit]
 *  links, and headings wrapped in a link to themselves. */
export function cleanHeadingLine(line: string): string {
	return line
		.replace(/\\?\[\s*\[edit\]\([^)]*\)\s*\\?\]/gi, "")
		.replace(/\[(?:¶|#|§|)\]\(#[^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\(#[^)\s]*\)/g, "$1")
		.replace(/\s+$/, "");
}

const PROMPT_RE = /^(>>>|\.\.\.)( |$)/;

/** A `>>>` session → { code, output }; null when the block is not one. */
export function splitDoctest(body: string): { code: string; output: string } | null {
	const lines = body.split("\n");
	if (!lines.some((l) => l.startsWith(">>> "))) return null;
	const code: string[] = [];
	const output: string[] = [];
	for (const line of lines) {
		if (PROMPT_RE.test(line)) code.push(line.replace(PROMPT_RE, ""));
		else if (line.trim()) output.push(line);
	}
	return { code: code.join("\n").replace(/\n+$/, ""), output: output.join("\n") };
}

/** Prose → chunks of at most `max` chars, split at blank lines. */
function chunkProse(text: string, max: number): string[] {
	if (text.length <= max) return [text];
	const chunks: string[] = [];
	let current = "";
	for (const para of text.split(/\n{2,}/)) {
		if (current && current.length + para.length + 2 > max) {
			chunks.push(current);
			current = para;
		} else current = current ? `${current}\n\n${para}` : para;
	}
	if (current) chunks.push(current);
	return chunks;
}

export function clipSourceCell(url: string, title: string, clippedAt: string): string {
	const safeTitle = title.replace(/[[\]]/g, "") || url;
	return `> Source: [${safeTitle}](${url}) · clipped ${clippedAt.slice(0, 10)}`;
}

/**
 * Markdown → cells: a source-link aside, then the page split at `#`/`##`
 * headings into sections (back matter like References dropped). Inside a
 * section, `###` headings and long prose start new aside cells; each fenced
 * code block is its own code cell (language kept; a `>>>` session becomes
 * runnable code with its printed results as output).
 */
export function pageToCells(markdown: string, meta: { url: string; title: string; clippedAt: string }): ClipPlan {
	const cells: ClipCell[] = [{ role: "aside", source: clipSourceCell(meta.url, meta.title, meta.clippedAt), section: -1 }];
	const sections: ClipSection[] = [];

	let section = -1;
	let skipping = false;
	let prose: string[] = [];
	let code: string[] | null = null;
	let fence = "";
	let lang = "";

	const startSection = (heading: string) => {
		section = sections.length;
		sections.push({ index: section, heading, text: "" });
	};
	const note = (text: string) => {
		if (section < 0) startSection(meta.title || "Introduction");
		const s = sections[section]!;
		s.text = s.text ? `${s.text}\n\n${text}` : text;
	};
	const flushProse = () => {
		const text = prose.join("\n").replace(/^\n+|\s+$/g, "");
		prose = [];
		if (!text.trim()) return;
		note(text);
		for (const chunk of chunkProse(text, MAX_PROSE_CELL_CHARS)) cells.push({ role: "aside", source: chunk, section });
	};
	const flushCode = (body: string) => {
		if (!body.trim()) return;
		const doctest = splitDoctest(body);
		const source = doctest ? doctest.code : body;
		const cellLang = lang || (doctest ? "python" : "");
		note(`\`\`\`${cellLang}\n${body}\n\`\`\``);
		cells.push({ role: "code", source, ...(cellLang ? { lang: cellLang } : {}), ...(doctest?.output ? { output: doctest.output } : {}), section });
	};

	for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
		if (code) {
			const close = FENCE_RE.exec(raw);
			if (close && close[2]!.startsWith(fence) && close[3] === "") {
				if (!skipping) flushCode(code.join("\n"));
				code = null;
			} else code.push(raw);
			continue;
		}
		const open = FENCE_RE.exec(raw);
		if (open) {
			flushProse();
			code = [];
			fence = open[2]!;
			lang = open[3]!.toLowerCase();
			continue;
		}
		const line = /^#{1,6}\s/.test(raw) ? cleanHeadingLine(raw) : raw;
		const heading = SECTION_HEADING_RE.exec(line);
		if (heading) {
			flushProse();
			skipping = BACK_MATTER_RE.test(heading[1]!.trim());
			if (!skipping) startSection(heading[1]!);
		} else if (SUBHEADING_RE.test(line)) flushProse();
		if (!skipping) prose.push(line);
	}
	if (code && !skipping) flushCode(code.join("\n")); // an unclosed fence: keep it as code
	flushProse();

	if (cells.length > MAX_CLIP_CELLS) {
		const kept = cells.slice(0, MAX_CLIP_CELLS - 1);
		const rest = cells.slice(MAX_CLIP_CELLS - 1);
		const tail = rest.map((c) => (c.role === "code" ? `\`\`\`${c.lang ?? ""}\n${c.source}\n\`\`\`` : c.source)).join("\n\n");
		kept.push({ role: "aside", source: tail, section: rest[0]!.section });
		return { cells: kept, sections };
	}
	return { cells, sections };
}

// ─── exercises ──────────────────────────────────────────────────────────────

export const CLIP_EXERCISE_SYSTEM_PROMPT = `You turn a web page the learner is reading into practice. For each section that teaches something worth checking, write ONE exercise that makes the learner use the idea — explain it in their own words, predict an outcome, apply it to a new case, or (for code) change or extend the code. Skip sections with nothing to practise (navigation, credits, asides).

Each exercise is short markdown (KaTeX $…$ allowed), answerable from the page plus thought, without the answer in it. When an exercise asks for code, ask for Python or C++.

Reply with ONLY a JSON array, no prose, no fences: [{"section": <number>, "exercise": "<markdown>"}]`;

export function clipExercisePrompt(title: string, url: string, sections: ClipSection[]): string {
	let budget = TOTAL_PROMPT_CHARS;
	const parts: string[] = [];
	for (const s of sections) {
		if (budget <= 0) break;
		const text = s.text.slice(0, Math.min(SECTION_PROMPT_CHARS, budget));
		budget -= text.length;
		parts.push(`<section number="${s.index}" heading="${s.heading.replace(/"/g, "'")}">\n${text}\n</section>`);
	}
	return `Page: ${title}\nURL: ${url}\n\n${parts.join("\n\n")}`;
}

export interface ClipExercise {
	section: number;
	exercise: string;
}

/** The model's reply → exercises for known sections (one per section; junk dropped). */
export function parseClipExercises(reply: string, sectionCount: number): ClipExercise[] {
	const start = reply.indexOf("[");
	const end = reply.lastIndexOf("]");
	if (start < 0 || end <= start) return [];
	let raw: unknown;
	try {
		raw = JSON.parse(reply.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(raw)) return [];
	const seen = new Set<number>();
	const out: ClipExercise[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const { section, exercise } = item as Record<string, unknown>;
		if (typeof section !== "number" || !Number.isInteger(section) || section < 0 || section >= sectionCount) continue;
		if (typeof exercise !== "string" || !exercise.trim() || seen.has(section)) continue;
		seen.add(section);
		out.push({ section, exercise: exercise.trim() });
	}
	return out;
}
