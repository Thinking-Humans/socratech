/**
 * Web clip (docs/web-clip.md, owner 2026-11-15): a page → a new notebook,
 * returned at once; exercise cells follow in the background on the strong
 * slot (whatever provider Settings picked: key, subscription, Claude Code).
 * Reached through the MCP tool import_page_as_notebook — by the Chrome
 * extension and by any MCP client.
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { appendCell, JournalError, newJournal } from "../core/journal.ts";
import type { Journal } from "../core/contracts/journal.ts";
import { CLIP_EXERCISE_SYSTEM_PROMPT, clipExercisePrompt, pageToCells, parseClipExercises, type ClipSection } from "../core/web-clip.ts";
import { safeFetch } from "../agent/tools/safe-fetch.ts";
import { addJournalCell, newCellId, newJournalId } from "./journals.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { strongTextStream } from "./model-text.ts";
import { stores } from "./stores.ts";

/** Largest page accepted (characters of html or markdown). */
export const MAX_CLIP_CHARS = 2_000_000;
const FETCH_TIMEOUT_MS = 30_000;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
// Keep the code block's language: <pre><code class="language-py">.
turndown.addRule("fencedWithLang", {
	filter: (node) => node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE",
	replacement: (_content, node) => {
		const codeEl = node.firstChild as HTMLElement;
		const cls = `${codeEl.getAttribute?.("class") ?? ""} ${(node as HTMLElement).getAttribute?.("class") ?? ""}`;
		const lang = /(?:language|lang)-([\w+#-]+)/.exec(cls)?.[1] ?? "";
		const body = (codeEl.textContent ?? "").replace(/\n$/, "");
		const fence = body.includes("```") ? "~~~~" : "```";
		return `\n\n${fence}${lang}\n${body}\n${fence}\n\n`;
	},
});

/** Page html → { title, markdown }: Readability when it finds an article,
 *  else the html as given (an already-extracted article). */
export function clipHtmlToMarkdown(html: string): { title: string; markdown: string } {
	const { document } = parseHTML(html);
	let title = "";
	let body = html;
	try {
		const article = new Readability(document.cloneNode(true) as unknown as Document).parse();
		if (article?.content && article.content.length > 200) {
			title = article.title ?? "";
			body = article.content;
		}
	} catch {
		// Readability refused the document — convert it whole.
	}
	if (!title) title = (document as unknown as Document).title ?? "";
	return { title, markdown: turndown.turndown(body).trim() };
}

async function fetchPage(url: string): Promise<{ title: string; markdown: string }> {
	const resp = await safeFetch(url, {
		headers: { Accept: "text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.5" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!resp.ok) throw new JournalError(`Fetching ${url} failed: HTTP ${resp.status}.`, "invalid");
	const type = resp.headers.get("content-type") ?? "";
	const text = await resp.text();
	if (text.length > MAX_CLIP_CHARS) throw new JournalError("The page is too large to clip.", "invalid");
	if (type.includes("html")) return clipHtmlToMarkdown(text);
	if (type.startsWith("text/")) return { title: "", markdown: text };
	throw new JournalError(`Cannot clip ${type.split(";")[0] || "this content type"} — pass the page as html or markdown.`, "invalid");
}

export interface ClipInput {
	url: string;
	title?: string;
	html?: string;
	markdown?: string;
}

export interface ClipResult {
	journal: Journal;
	/** Whether exercise cells are being written in the background. */
	exercises: "queued" | "no-model" | "no-sections";
	/** Settles when the background exercises are in (tests await it). */
	done: Promise<void>;
}

type ExerciseWriter = (system: string, prompt: string) => Promise<string>;
let writerOverride: ExerciseWriter | null = null;
/** Tests: a fake strong model for the exercise call. */
export function setClipExerciseWriterForTests(writer: ExerciseWriter | null): void {
	writerOverride = writer;
}

function strongWriter(): ExerciseWriter | null {
	if (writerOverride) return writerOverride;
	if (!resolveRoleSpec("teacher", stores.settingsStore.readSettings())) return null;
	return async (system, prompt) => {
		const reader = strongTextStream(system, prompt, "web-clip").getReader();
		const dec = new TextDecoder();
		let text = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return text + dec.decode();
			text += dec.decode(value, { stream: true });
		}
	};
}

/** Clip a page into a new notebook. Throws JournalError on bad input. */
export async function clipPage(input: ClipInput): Promise<ClipResult> {
	let url: URL;
	try {
		url = new URL(input.url);
	} catch {
		throw new JournalError("url must be an absolute http(s) URL.", "invalid");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new JournalError("url must be an absolute http(s) URL.", "invalid");
	const size = (input.html?.length ?? 0) + (input.markdown?.length ?? 0);
	if (size > MAX_CLIP_CHARS) throw new JournalError("The page is too large to clip.", "invalid");

	const page = input.markdown?.trim()
		? { title: "", markdown: input.markdown }
		: input.html?.trim()
			? clipHtmlToMarkdown(input.html)
			: await fetchPage(url.href);
	if (!page.markdown.trim()) throw new JournalError("The page has no readable text.", "invalid");

	const title = (input.title?.trim() || page.title.trim() || url.hostname).slice(0, 200);
	const now = new Date().toISOString();
	const plan = pageToCells(page.markdown, { url: url.href, title, clippedAt: now });

	let journal = newJournal({ id: newJournalId(), title, tags: ["clip"], now });
	const lastCellOfSection = new Map<number, string>();
	for (const cell of plan.cells) {
		const id = newCellId();
		journal = appendCell(journal, { id, role: cell.role, source: cell.source, ...(cell.lang ? { lang: cell.lang } : {}), publish: false }, now);
		lastCellOfSection.set(cell.section, id);
	}
	journal = stores.journalStore.createJournal(journal);

	if (plan.sections.length === 0) return { journal, exercises: "no-sections", done: Promise.resolve() };
	const writer = strongWriter();
	if (!writer) return { journal, exercises: "no-model", done: Promise.resolve() };
	const done = writeExercises(journal.id, title, url.href, plan.sections, lastCellOfSection, writer).catch((err) => {
		console.error("[web-clip] exercises failed:", err);
	});
	return { journal, exercises: "queued", done };
}

async function writeExercises(
	journalId: string,
	title: string,
	url: string,
	sections: ClipSection[],
	anchors: Map<number, string>,
	writer: ExerciseWriter,
): Promise<void> {
	const reply = await writer(CLIP_EXERCISE_SYSTEM_PROMPT, clipExercisePrompt(title, url, sections));
	if (/\*\(failed: /.test(reply)) throw new Error(reply.trim());
	for (const { section, exercise } of parseClipExercises(reply, sections.length)) {
		const fresh = stores.journalStore.getJournal(journalId);
		if (!fresh) return; // deleted meanwhile
		const anchor = anchors.get(section);
		const afterId = anchor && fresh.cells.some((c) => c.id === anchor) ? anchor : undefined;
		addJournalCell(journalId, { role: "exercise", source: exercise }, afterId);
	}
}
