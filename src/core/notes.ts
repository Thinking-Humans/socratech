/**
 * Pure note transforms (docs/notes-first.md): find the `/ask` question and
 * its `## ` section, render Claude's answer as an Obsidian callout.
 * Browser-safe; shared by the editor and the server.
 */

export const ASK_LINE_RE = /^\/ask\s+(\S.*)$/;

export interface AskContext {
	question: string;
	/** The `## ` heading the ask sits under ("" when none). */
	topic: string;
	/** The section's text (heading through the line before the next `## `/`# `), the ask line excluded. */
	section: string;
	/** The note's `# ` title, when it has one. */
	title: string;
}

/** `lineNumber` is 1-based (CodeMirror's). Null when that line is not an /ask. */
export function askContext(content: string, lineNumber: number): AskContext | null {
	const lines = content.split("\n");
	const idx = lineNumber - 1;
	const m = lines[idx]?.match(ASK_LINE_RE);
	if (!m) return null;
	let start = 0;
	for (let i = idx; i >= 0; i--) {
		if (/^#{1,2}\s/.test(lines[i]!)) {
			start = i;
			break;
		}
	}
	let end = lines.length;
	for (let i = idx + 1; i < lines.length; i++) {
		if (/^#{1,2}\s/.test(lines[i]!)) {
			end = i;
			break;
		}
	}
	const heading = lines[start]!.match(/^##\s+(.*)$/);
	const titleLine = lines.find((l) => /^#\s/.test(l));
	return {
		question: m[1]!.trim(),
		topic: heading ? heading[1]!.trim() : "",
		section: lines.slice(start, end).filter((_, i) => start + i !== idx).join("\n").trim(),
		title: titleLine ? titleLine.replace(/^#\s+/, "").trim() : "",
	};
}

/** The callout head that replaces the `/ask` line. */
export function calloutHead(question: string): string {
	return `> [!claude] ${question}`;
}

/** Answer text → callout body lines (every line `> `-prefixed). */
export function calloutBody(answer: string): string {
	return answer
		.replace(/\s+$/, "")
		.split("\n")
		.map((l) => (l ? `> ${l}` : ">"))
		.join("\n");
}

export const ASK_SYSTEM_PROMPT = `You answer questions written inline in a learner's markdown notes. The learner is studying and writing about what they learn.

- Answer the question directly, grounded in what their section already says. Correct misconceptions in it plainly.
- Be concise: a short paragraph or a few bullets; go longer only when the question needs it.
- Markdown is fine; math as $…$ / $$…$$. No headings (your answer sits inside a callout).
- End with at most one short follow-up question that would push their understanding, prefixed "→ ".`;

export function askPrompt(ctx: AskContext): string {
	return [
		ctx.title ? `Note: ${ctx.title}` : "",
		ctx.topic ? `Section: ${ctx.topic}` : "",
		ctx.section ? `What the learner wrote in this section:\n"""\n${ctx.section}\n"""` : "",
		`Question: ${ctx.question}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

// ── Journeys (docs/notes-first.md N5) ─────────────────────────────────────
// A `## Topic` section that started a journey keeps a marker line under its
// heading: `<!-- journey:teach:<chatId> -->`. HTML comments stay invisible in
// Obsidian's reading view; the editor shows them muted and offers "resume".

export type JourneyKind = "teach" | "practice" | "improvise";
export const JOURNEY_KINDS: readonly JourneyKind[] = ["teach", "practice", "improvise"];
export const JOURNEY_MARKER_RE = /^<!--\s*journey:(teach|practice|improvise):([A-Za-z0-9_-]+)\s*-->\s*$/;
const SECTION_TOPIC_RE = /^##\s+(\S.*)$/;

export interface JourneyRef {
	kind: JourneyKind;
	chatId: string;
	/** 1-based line of the marker. */
	line: number;
}

export interface JourneySection {
	topic: string;
	/** Section body, heading and journey markers excluded. */
	section: string;
	journeys: JourneyRef[];
}

export function journeyMarker(kind: JourneyKind, chatId: string): string {
	return `<!-- journey:${kind}:${chatId} -->`;
}

/** The `## ` section whose heading is line `n` (1-based), or null. */
export function journeySection(doc: string, n: number): JourneySection | null {
	const lines = doc.split("\n");
	const m = lines[n - 1]?.match(SECTION_TOPIC_RE);
	if (!m) return null;
	const body: string[] = [];
	const journeys: JourneyRef[] = [];
	for (let i = n; i < lines.length && !/^#{1,2}\s/.test(lines[i]!); i++) {
		const j = lines[i]!.match(JOURNEY_MARKER_RE);
		if (j) journeys.push({ kind: j[1] as JourneyKind, chatId: j[2]!, line: i + 1 });
		else body.push(lines[i]!);
	}
	return { topic: m[1]!.trim(), section: body.join("\n").trim(), journeys };
}

/** The opening learner message for a journey seeded from a note section. */
export function journeyPrompt(kind: JourneyKind, topic: string, section: string): string {
	const notes = section ? `Here's what I've written on **${topic}** so far:\n\n${section}\n\n` : "";
	if (kind === "practice")
		return section
			? `${notes}Give me practice problems on this, starting just at the edge of what my notes show I know.`
			: `I want to practise **${topic}**. Give me a first problem and adjust from how I do.`;
	if (kind === "improvise")
		return section
			? `${notes}Let's improvise with this: throw me an open-ended scenario that makes me use these ideas in a way my notes don't cover.`
			: `Let's improvise around **${topic}**: give me an open-ended scenario to play with.`;
	return section
		? `${notes}Start from what I wrote: check what I've got right or wrong, then take me deeper.`
		: `I want to learn about **${topic}**. Start by finding out what I already know.`;
}
