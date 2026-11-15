/**
 * Journal → publishable bundle (docs/learn-in-public.md D5, owner
 * 2026-11-15). Pure: journal in, file map out. Only cells whose publish
 * switch is on reach the bundle — the stored journal is the private
 * working copy; this is the public artifact.
 *
 *   markdown  <date>-<slug>/index.md        front matter + body
 *   notebook  <date>-<slug>/index.md        front matter only
 *             <date>-<slug>/notebook.ipynb  the post (nbformat 4, role tags)
 *
 * Markdown conventions (portable: goldmark/Hugo, kramdown/Jekyll, GitHub):
 *   reflection  plain markdown
 *   aside       <aside class="note" markdown="1"> … </aside>
 *   exercise    <div class="exercise" markdown="1"> **Exercise n** … </div>
 *   attempt     <div class="attempt" markdown="1"> **Attempt** … </div>
 *   verdict     <div class="verdict" markdown="1"> **Verdict** … </div>
 *   code        fenced block (static, never executable); recorded output in
 *               <div class="output" markdown="1"> + a ```text fence
 * The blank lines inside each wrapper let CommonMark parse the content as
 * markdown; `markdown="1"` does the same for kramdown. Math passes through
 * untouched for the site's KaTeX step.
 */

import type { Journal, JournalCell, JournalCellRole, JournalExportFormat } from "./contracts/journal.ts";

export interface JournalExportOptions {
	/** Post date: "YYYY-MM-DD" or a full ISO timestamp. The bundle
	 *  directory uses its first 10 characters. */
	date: string;
	format: JournalExportFormat;
	/** Graph idea id → name. Names of ideas targeted by PUBLISHED exercise
	 *  cells become post tags. Unknown ids are skipped. */
	ideaNames?: Readonly<Record<string, string>>;
	/** Code language when a code cell names none (default "python"). */
	defaultLang?: string;
	/** Republish (R5): the directory name pinned at first publish. Wins
	 *  over `<date>-<slug>`. */
	dirName?: string;
	/** Republish: "YYYY-MM-DD" of this update → front-matter `lastmod`. */
	lastmod?: string;
}

export interface JournalBundle {
	/** "<YYYY-MM-DD>-<slug>" — the directory name under the site's content dir. */
	dir: string;
	/** File name within dir → contents. */
	files: Record<string, string>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export function publishedCells(journal: Journal): JournalCell[] {
	return journal.cells.filter((c) => c.publish && (c.source.trim() !== "" || (c.output ?? "").trim() !== ""));
}

/** Tags = the journal's own tags + names of ideas behind published exercises. */
export function bundleTags(journal: Journal, ideaNames: Readonly<Record<string, string>> = {}): string[] {
	const tags = [...journal.tags];
	for (const cell of publishedCells(journal)) {
		if (cell.role !== "exercise") continue;
		for (const id of cell.origin?.ideaIds ?? []) {
			const name = ideaNames[id];
			if (name) tags.push(name);
		}
	}
	return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}

function publishedIdeaIds(journal: Journal): string[] {
	const ids = publishedCells(journal).flatMap((c) => (c.role === "exercise" ? (c.origin?.ideaIds ?? []) : []));
	return [...new Set(ids)];
}

/** A fence longer than any backtick run inside `text`. */
function fence(text: string, info = ""): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	const ticks = "`".repeat(Math.max(3, longest + 1));
	return `${ticks}${info}\n${text.replace(/\n+$/, "")}\n${ticks}`;
}

function wrap(tag: "div" | "aside", cls: string, body: string): string {
	return `<${tag} class="${cls}" markdown="1">\n\n${body}\n\n</${tag}>`;
}

const LABEL: Partial<Record<JournalCellRole, string>> = { attempt: "Attempt", verdict: "Verdict" };

/** One cell as markdown. `n` numbers exercises. */
function cellMarkdown(cell: JournalCell, n: number, defaultLang: string): string {
	const src = cell.source.trim();
	switch (cell.role) {
		case "reflection":
			return src;
		case "aside":
			return wrap("aside", "note", src);
		case "exercise":
			return wrap("div", "exercise", `**Exercise ${n}**\n\n${src}`);
		case "attempt":
		case "verdict":
			return wrap("div", cell.role, `**${LABEL[cell.role]}**\n\n${src}`);
		case "code": {
			const parts = [];
			if (src) parts.push(fence(cell.source, cell.lang || defaultLang));
			if (cell.output?.trim()) parts.push(wrap("div", "output", fence(cell.output, "text")));
			return parts.join("\n\n");
		}
	}
}

/** Body markdown of the published cells (no front matter). */
export function renderJournalMarkdown(journal: Journal, defaultLang = "python"): string {
	let n = 0;
	const blocks = publishedCells(journal).map((cell) => cellMarkdown(cell, cell.role === "exercise" ? ++n : n, defaultLang));
	return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

/** YAML front matter. Strings are JSON-quoted — a JSON string is a valid
 *  YAML double-quoted scalar, so titles with colons, quotes or `#` survive. */
export function renderFrontMatter(journal: Journal, opts: JournalExportOptions): string {
	const q = (s: string) => JSON.stringify(s);
	const list = (xs: string[]) => `[${xs.map(q).join(", ")}]`;
	return [
		"---",
		`title: ${q(journal.title)}`,
		`date: ${opts.date}`,
		...(opts.lastmod ? [`lastmod: ${opts.lastmod}`] : []),
		`tags: ${list(bundleTags(journal, opts.ideaNames))}`,
		"draft: false",
		"socratech:",
		`  journal: ${q(journal.id)}`,
		`  ideas: ${list(publishedIdeaIds(journal))}`,
		"---",
		"",
	].join("\n");
}

/** nbformat source: lines with their newlines (last line without). */
function nbSource(text: string): string[] {
	const lines = text.replace(/\n+$/, "").split("\n");
	return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
}

function mostCommonLang(cells: JournalCell[], fallback: string): string {
	const counts = new Map<string, number>();
	for (const c of cells) if (c.role === "code" && c.lang) counts.set(c.lang, (counts.get(c.lang) ?? 0) + 1);
	let best = fallback;
	let max = 0;
	for (const [lang, k] of counts) if (k > max) [best, max] = [lang, k];
	return best;
}

export function renderJournalNotebook(journal: Journal, defaultLang = "python"): string {
	const cells = publishedCells(journal);
	let n = 0;
	const nbCells = cells.map((cell) => {
		const metadata = { tags: [cell.role] };
		if (cell.role === "code") {
			return {
				cell_type: "code",
				execution_count: null,
				metadata: cell.lang ? { ...metadata, language: cell.lang } : metadata,
				outputs: cell.output?.trim()
					? [{ output_type: "stream", name: "stdout", text: cell.output.replace(/\n*$/, "\n").split(/(?<=\n)/) }]
					: [],
				source: nbSource(cell.source),
			};
		}
		const label =
			cell.role === "exercise" ? `**Exercise ${++n}**\n\n` : LABEL[cell.role] ? `**${LABEL[cell.role]}**\n\n` : "";
		return { cell_type: "markdown", metadata, source: nbSource(label + cell.source.trim()) };
	});
	const lang = mostCommonLang(cells, defaultLang);
	const nb = {
		cells: nbCells,
		metadata: { language_info: { name: lang }, socratech: { journal: journal.id } },
		nbformat: 4,
		nbformat_minor: 5,
	};
	return `${JSON.stringify(nb, null, 1)}\n`;
}

export function exportJournal(journal: Journal, opts: JournalExportOptions): JournalBundle {
	if (!DATE_RE.test(opts.date)) throw new Error(`Export date must start with YYYY-MM-DD, got "${opts.date}".`);
	const dir = opts.dirName ?? `${opts.date.slice(0, 10)}-${journal.slug}`;
	const lang = opts.defaultLang ?? "python";
	const front = renderFrontMatter(journal, opts);
	if (opts.format === "notebook") {
		return { dir, files: { "index.md": front, "notebook.ipynb": renderJournalNotebook(journal, lang) } };
	}
	const body = renderJournalMarkdown(journal, lang);
	return { dir, files: { "index.md": body ? `${front}\n${body}` : front } };
}
