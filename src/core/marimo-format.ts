/**
 * Marimo storage for notebooks (docs/learn-in-public.md "Marimo storage",
 * owner 2026-11-15). Pure: Journal ⇄ { py, sidecar }.
 *
 *   <id>.py              a marimo notebook — every readable word lives here:
 *                        markdown cells, agent prompts AND answers, Python
 *                        code, C++ (and other non-Python) code.
 *   <id>.socratech.json  the sidecar — everything marimo has no slot for:
 *                        journal metadata and per-cell role, publish switch,
 *                        run counter, code output, origin, rating, graph…
 *
 * Cell shapes in the .py (cell code shown dedented, as marimo shows it):
 *
 *   python code      the source, verbatim, in `@app.cell def <name>(refs)`
 *                    with `return (defs,)` — refs/defs are a best-effort
 *                    reading of the code (pythonNames below). marimo
 *                    regenerates every signature and return when it opens
 *                    the file, so they only have to be close.
 *   markdown roles   `mo.md(r"""\n<text>\n""")` — marimo's own convention,
 *   (reflection,     so marimo opens them in its markdown editor.
 *    aside, exercise,
 *    attempt, verdict)
 *   other code       `mo.md(r"""\n```cpp\n<source>\n```\n""")` — renders as
 *   (cpp, …)         a highlighted block; marimo never runs it. The fence
 *                    is longer than any backtick run in the source.
 *   agent            `_prompt = r"""…"""`, optional `_answer = r"""…"""`,
 *                    then a display line (callout + answer).
 *
 * Cell ids: the cell function's NAME is the cell id (`def cell_3f2a…():`),
 * so the match to the sidecar survives reordering and edits in marimo.
 * Ids that are not safe Python names are escaped as `c_<…>` (cellFnName).
 * marimo keeps cell names when it saves; it drops them only for cells it
 * cannot parse (`app._unparsable_cell(…, name="_")`), and anonymous cells
 * (`def _`) are ones added in marimo. Such cells re-attach to an unclaimed
 * sidecar entry with the same text hash, or get a fresh id.
 *
 * Strings: `r"""` when the text allows it (no `"""`, no control characters),
 * else `r'''`, else an escaped `"""` literal. The reader decodes Python
 * literals exactly, so every text round-trips.
 *
 * Every line of a cell's code is indented 4 spaces in the file (marimo does
 * the same, string contents included) and the reader strips them again.
 * marimo trims trailing blank lines of a cell when it saves; the reader
 * restores them only when the sidecar's hash says the untrimmed text is the
 * one that was saved.
 */

import type { Journal, JournalCell, JournalCellRole } from "./contracts/journal.ts";
import { DEFAULT_PUBLISH } from "./contracts/journal.ts";
import { runnableLang } from "./journal-code.ts";
import { slugify } from "./journal.ts";
import { textHash } from "./notebook-learning.ts";

/** The marimo version the generated header names (informational only). */
export const MARIMO_GENERATED_WITH = "0.25.2";
export const NOTEBOOK_SIDECAR_FORMAT = "socratech-notebook";
export const NOTEBOOK_SIDECAR_VERSION = 1;

/** A cell's sidecar entry: every field except the text the .py carries
 *  (`source` always; `output` too for agent cells), plus the text's hash —
 *  a different hash on read means the .py was edited by hand. */
export type NotebookSidecarCell = Omit<JournalCell, "source"> & { sourceHash: string };

/** Every Journal field except the cells, plus per-cell metadata. Unknown
 *  top-level fields ride along untouched, so new Journal fields need no
 *  format change. */
export type NotebookSidecar = Omit<Journal, "cells"> & {
	format: typeof NOTEBOOK_SIDECAR_FORMAT;
	version: number;
	cells: NotebookSidecarCell[];
};

export interface MarimoNotebook {
	py: string;
	sidecar: NotebookSidecar;
}

const MARKDOWN_ROLES: readonly JournalCellRole[] = ["reflection", "aside", "exercise", "attempt", "verdict"];
const AGENT_DISPLAY = 'mo.vstack([mo.callout(mo.md(_prompt), kind="info"), mo.md(_answer)])';
const AGENT_DISPLAY_NO_ANSWER = 'mo.callout(mo.md(_prompt), kind="info")';
const MO_IMPORT = "import marimo as mo";

const PY_KEYWORDS = new Set(
	"False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "),
);
/** Module-level names a cell function must not take: the file itself uses them. */
const RESERVED_FN_NAMES = new Set(["app", "marimo", "mo"]);

/** A code cell that is a real (runnable) marimo Python cell. */
export function isPythonCell(cell: Pick<JournalCell, "role" | "lang">): boolean {
	return cell.role === "code" && (!(cell.lang ?? "").trim() || runnableLang(cell.lang) === "python");
}

// ─── cell names ⇄ ids ───────────────────────────────────────────────────────

/** Cell id → the marimo cell function name. Safe ids are used as-is;
 *  anything else (and anything starting `c_` or `_`) becomes `c_` + the id
 *  with each non-alphanumeric character written `_<hex>_`. */
export function cellFnName(id: string): string {
	const safe = /^[A-Za-z][A-Za-z0-9_]*$/.test(id) && !id.startsWith("c_") && !PY_KEYWORDS.has(id) && !RESERVED_FN_NAMES.has(id);
	if (safe) return id;
	let out = "c_";
	for (const ch of id) out += /[A-Za-z0-9]/.test(ch) ? ch : `_${ch.codePointAt(0)!.toString(16)}_`;
	return out;
}

/** Cell function name → id; null for an anonymous cell (`_`, `__`, …). */
export function cellIdFromFnName(name: string): string | null {
	if (/^_+$/.test(name)) return null;
	if (!name.startsWith("c_")) return name;
	const body = name.slice(2);
	let out = "";
	for (let i = 0; i < body.length; ) {
		if (body[i] !== "_") {
			out += body[i++];
			continue;
		}
		const close = body.indexOf("_", i + 1);
		const hex = close > i ? body.slice(i + 1, close) : "";
		if (!/^[0-9a-f]+$/.test(hex)) return name; // not our escape: the name itself
		out += String.fromCodePoint(parseInt(hex, 16));
		i = close + 1;
	}
	return out;
}

// ─── Python string literals ─────────────────────────────────────────────────

/** Characters a raw literal cannot carry losslessly: controls other than
 *  tab/newline (Python normalizes \r, refuses NUL) and lone surrogates. */
const RAW_UNSAFE = /[\x00-\x08\x0b-\x1f\x7f]|[\ud800-\udfff]/u;

/** `text` as a triple-quoted literal whose value is "\n" + text + "\n". */
export function pyBlockString(text: string): string {
	const content = `\n${text}\n`;
	if (!RAW_UNSAFE.test(content)) {
		if (!content.includes('"""')) return `r"""${content}"""`;
		if (!content.includes("'''")) return `r'''${content}'''`;
	}
	let out = "";
	for (const ch of content) {
		const cp = ch.codePointAt(0)!;
		if (ch === "\\") out += "\\\\";
		else if (ch === '"') out += '\\"';
		else if (ch === "\n" || ch === "\t") out += ch;
		else if (ch === "\r") out += "\\r";
		else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
		else if (cp >= 0xd800 && cp <= 0xdfff) out += `\\u${cp.toString(16)}`;
		else out += ch;
	}
	return `"""${out}"""`;
}

/** Undo pyBlockString's wrapping: drop one leading and one trailing "\n". */
function unwrapBlock(value: string): string {
	let v = value;
	if (v.startsWith("\n")) v = v.slice(1);
	if (v.endsWith("\n")) v = v.slice(0, -1);
	return v;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/** Read one Python str literal starting at `at` (prefix r/u allowed; b/f
 *  refused). Exact Python semantics. Null when there is none. */
export function readPyString(src: string, at: number): { value: string; end: number } | null {
	const m = /^([rRuU]{0,2})("""|'''|"|')/.exec(src.slice(at, at + 5));
	if (!m) return null;
	const prefix = m[1]!.toLowerCase();
	if (prefix.length === 2 && prefix !== "ur" && prefix !== "ru") return null;
	const raw = prefix.includes("r");
	const quote = m[2]!;
	let i = at + m[0].length;
	let out = "";
	for (;;) {
		if (i >= src.length) return null;
		if (src.startsWith(quote, i)) return { value: out, end: i + quote.length };
		const ch = src[i]!;
		if (quote.length === 1 && ch === "\n") return null;
		if (ch !== "\\") {
			out += ch;
			i++;
			continue;
		}
		const next = src[i + 1];
		if (next === undefined) return null;
		if (raw) {
			out += ch + next;
			i += 2;
			continue;
		}
		if (next === "\n") {
			i += 2;
			continue;
		}
		if (SIMPLE_ESCAPES[next] !== undefined) {
			out += SIMPLE_ESCAPES[next];
			i += 2;
			continue;
		}
		const oct = /^[0-7]{1,3}/.exec(src.slice(i + 1, i + 4));
		if (oct) {
			out += String.fromCharCode(parseInt(oct[0], 8));
			i += 1 + oct[0].length;
			continue;
		}
		const width = next === "x" ? 2 : next === "u" ? 4 : next === "U" ? 8 : 0;
		if (width) {
			const hex = src.slice(i + 2, i + 2 + width);
			if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) return null;
			const cp = parseInt(hex, 16);
			if (cp > 0x10ffff) return null;
			out += cp < 0x10000 ? String.fromCharCode(cp) : String.fromCodePoint(cp);
			i += 2 + width;
			continue;
		}
		out += ch + next; // unknown escape: Python keeps it as written (\N{name} is not decoded here; the writer never emits it)
		i += 2;
	}
}

function skipSpace(src: string, at: number): number {
	let i = at;
	while (i < src.length && /\s/.test(src[i]!)) i++;
	return i;
}

// ─── Python names (best-effort refs/defs for marimo signatures) ─────────────

const STRING_PREFIX = /^(?:[rRuUbBfF]|[rR][bBfF]|[bBfF][rR])$/;

/** Code with string literals collapsed to `""` and comments dropped. */
function stripStringsAndComments(code: string): string {
	let out = "";
	let i = 0;
	while (i < code.length) {
		const ch = code[i]!;
		if (ch === "#") {
			while (i < code.length && code[i] !== "\n") i++;
			continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			const word = /^[A-Za-z_]\w*/.exec(code.slice(i))![0];
			const after = code[i + word.length];
			if ((after === '"' || after === "'") && STRING_PREFIX.test(word)) {
				i += word.length;
				continue; // the prefix; the string follows
			}
			out += word;
			i += word.length;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = code.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
			i += quote.length;
			while (i < code.length && !code.startsWith(quote, i)) {
				if (quote.length === 1 && code[i] === "\n") break;
				i += code[i] === "\\" ? 2 : 1;
			}
			i += quote.length;
			out += '""';
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** Logical lines (bracket and backslash continuations joined) with indent. */
function logicalLines(code: string): { indent: number; text: string }[] {
	const lines: { indent: number; text: string }[] = [];
	let depth = 0;
	let cur: { indent: number; text: string } | null = null;
	for (const physical of code.split("\n")) {
		if (cur === null) {
			if (!physical.trim()) continue;
			cur = { indent: physical.length - physical.trimStart().length, text: "" };
		}
		let line = physical;
		const continued = /\\\s*$/.test(line);
		if (continued) line = line.replace(/\\\s*$/, "");
		for (const c of line) {
			if ("([{".includes(c)) depth++;
			else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
		}
		cur.text += (cur.text ? " " : "") + line.trim();
		if (depth === 0 && !continued) {
			lines.push(cur);
			cur = null;
		}
	}
	if (cur) lines.push(cur);
	return lines;
}

/** Split at `sep` characters outside brackets. */
function splitTop(text: string, sep: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if ("([{".includes(c)) depth++;
		else if (")]}".includes(c)) depth--;
		else if (c === sep && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

function targetNames(target: string, into: Set<string>): void {
	let t = target.trim();
	const colon = splitTop(t, ":");
	if (colon.length > 1) t = colon[0]!.trim(); // annotated `x: int`
	while (/^[([].*[)\]]$/.test(t)) t = t.slice(1, -1).trim();
	const parts = splitTop(t, ",");
	if (parts.length > 1) {
		for (const p of parts) targetNames(p, into);
		return;
	}
	t = t.replace(/^\*/, "").trim();
	if (/^[A-Za-z_]\w*$/.test(t) && !PY_KEYWORDS.has(t)) into.add(t);
	else if (/^[([]/.test(t)) targetNames(t, into);
}

/** Assignment targets of one statement: the segments before its last
 *  top-level `=` (augmented assignments included). */
function assignmentTargets(stmt: string, into: Set<string>): void {
	const segs: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < stmt.length; i++) {
		const c = stmt[i]!;
		if ("([{".includes(c)) depth++;
		else if (")]}".includes(c)) depth--;
		else if (c === "=" && depth === 0) {
			const prev = stmt[i - 1] ?? "";
			if (stmt[i + 1] === "=" || "=!<>:".includes(prev) && !/(<<|>>)$/.test(stmt.slice(0, i))) {
				if (stmt[i + 1] === "=") i++;
				continue;
			}
			const aug = /(\*\*|\/\/|>>|<<|[-+*/%&|^@])$/.exec(stmt.slice(start, i));
			segs.push(aug ? stmt.slice(start, i - aug[0].length) : stmt.slice(start, i));
			start = i + 1;
		}
	}
	if (segs.length === 0) return;
	for (const s of segs) {
		if (/^\s*(lambda|if|elif|while|return|assert|yield|print)\b/.test(s)) return;
		targetNames(s, into);
	}
}

/**
 * Best-effort module-level names a Python cell defines and reads — enough
 * for marimo-shaped signatures. marimo rewrites them on open; the exact
 * redefinition check runs on python3's own `ast` (server/marimo-check.ts).
 * `_`-prefixed names are cell-local in marimo and never count.
 */
export function pythonNames(code: string): { defs: string[]; refs: string[] } {
	const clean = stripStringsAndComments(code);
	const defs = new Set<string>();
	const scopes: number[] = [];
	for (const { indent, text } of logicalLines(clean)) {
		while (scopes.length && scopes[scopes.length - 1]! >= indent) scopes.pop();
		if (text.startsWith("@")) continue;
		const fn = /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(text);
		if (fn) {
			if (scopes.length === 0) defs.add(fn[2]!);
			scopes.push(indent);
			continue;
		}
		if (scopes.length) continue; // a function / class body: locals
		for (const stmt of splitTop(text, ";")) {
			const s = stmt.trim();
			let m: RegExpExecArray | null;
			if ((m = /^import\s+(.+)$/.exec(s))) {
				for (const part of m[1]!.split(",")) {
					const as = /\bas\s+([A-Za-z_]\w*)\s*$/.exec(part);
					defs.add(as ? as[1]! : part.trim().split(".")[0]!);
				}
			} else if ((m = /^from\s+\S+\s+import\s+(.+)$/.exec(s))) {
				for (const part of m[1]!.replace(/[()]/g, "").split(",")) {
					const p = part.trim();
					if (!p || p === "*") continue;
					const as = /\bas\s+([A-Za-z_]\w*)$/.exec(p);
					defs.add(as ? as[1]! : p);
				}
			} else if ((m = /^(?:async\s+)?for\s+(.+?)\s+in\s/.exec(s))) {
				targetNames(m[1]!, defs);
			} else if (/^(?:async\s+)?with\b|^except\b/.test(s)) {
				for (const as of s.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) defs.add(as[1]!);
			} else {
				const head = /^(if|elif|else|while|try|finally|match|case)\b[^:]*:\s*(.*)$/.exec(s);
				assignmentTargets(head ? head[2]! : s, defs);
			}
			for (const w of s.matchAll(/([A-Za-z_]\w*)\s*:=/g)) defs.add(w[1]!);
		}
	}
	const refs = new Set<string>();
	for (const m of clean.matchAll(/(?<![.\w])([A-Za-z_]\w*)/g)) {
		const name = m[1]!;
		if (!PY_KEYWORDS.has(name) && !defs.has(name)) refs.add(name);
	}
	const keep = (s: Set<string>) => [...s].filter((n) => !n.startsWith("_")).sort();
	return { defs: keep(defs), refs: keep(refs) };
}

// ─── marimo-clean: redefinitions ────────────────────────────────────────────

export interface MarimoRedefinition {
	name: string;
	/** Every Python cell that defines `name`, in notebook order. */
	cellIds: string[];
	/** True when the clash is with the notebook's own `import marimo as mo`. */
	reserved?: boolean;
}

/** marimo refuses a notebook where two cells define the same global. Given
 *  each Python cell's module-level defs (python3 `ast`, server side), the
 *  names that clash — including `mo`, which the generated setup cell owns. */
export function marimoRedefinitions(cells: readonly { id: string; defs: readonly string[] }[]): MarimoRedefinition[] {
	const by = new Map<string, string[]>();
	for (const c of cells) for (const d of new Set(c.defs)) if (!d.startsWith("_")) by.set(d, [...(by.get(d) ?? []), c.id]);
	const out: MarimoRedefinition[] = [];
	for (const [name, ids] of by) {
		if (name === "mo") out.push({ name, cellIds: ids, reserved: true });
		else if (ids.length > 1) out.push({ name, cellIds: ids });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Journal → marimo ───────────────────────────────────────────────────────

function indentCode(code: string): string[] {
	if (code === "") return [];
	return code.split("\n").map((l) => (l === "" ? "" : `    ${l}`));
}

function cellBlock(name: string, args: string[], code: string, defs: string[], hideCode: boolean): string {
	const ret = defs.length === 0 ? "    return" : defs.length === 1 ? `    return (${defs[0]},)` : `    return (${defs.join(", ")})`;
	return [hideCode ? "@app.cell(hide_code=True)" : "@app.cell", `def ${name}(${args.join(", ")}):`, ...indentCode(code), ret].join("\n");
}

function longestRun(text: string, ch: string): number {
	let best = 0;
	let run = 0;
	for (const c of text) {
		run = c === ch ? run + 1 : 0;
		best = Math.max(best, run);
	}
	return best;
}

function fence(source: string, lang: string): string {
	const ticks = "`".repeat(Math.max(3, longestRun(source, "`") + 1));
	return `${ticks}${lang}\n${source}\n${ticks}`;
}

function cellCode(cell: JournalCell): string {
	if (cell.role === "agent") {
		const lines = [`_prompt = ${pyBlockString(cell.source)}`];
		if (cell.output !== undefined) lines.push(`_answer = ${pyBlockString(cell.output)}`);
		lines.push(cell.output !== undefined ? AGENT_DISPLAY : AGENT_DISPLAY_NO_ANSWER);
		return lines.join("\n");
	}
	if (cell.role === "code") return `mo.md(${pyBlockString(fence(cell.source, (cell.lang ?? "").trim()))})`;
	return `mo.md(${pyBlockString(cell.source)})`;
}

function sidecarCell(cell: JournalCell): NotebookSidecarCell {
	const { source, ...meta } = cell;
	if (cell.role === "agent") delete meta.output; // the answer is in the .py
	return { ...meta, sourceHash: textHash(source) };
}

/** The marimo `.py` and the sidecar for a journal. Deterministic. */
export function journalToMarimo(journal: Journal): MarimoNotebook {
	const { cells, ...rest } = journal;
	const py = cells.filter(isPythonCell).map((c) => ({ id: c.id, ...pythonNames(c.source) }));
	const definers = new Map<string, Set<string>>([["mo", new Set(["__mo__"])]]);
	for (const p of py) for (const d of p.defs) definers.set(d, (definers.get(d) ?? new Set()).add(p.id));
	const names = new Map(py.map((p) => [p.id, p]));

	const blocks = [cellBlock("_", [], MO_IMPORT, ["mo"], true)];
	for (const cell of cells) {
		const name = cellFnName(cell.id);
		const p = names.get(cell.id);
		if (p) {
			const args = p.refs.filter((r) => [...(definers.get(r) ?? [])].some((id) => id !== cell.id));
			blocks.push(cellBlock(name, args, cell.source, p.defs, false));
		} else {
			blocks.push(cellBlock(name, ["mo"], cellCode(cell), [], true));
		}
	}
	const pyText = [
		`import marimo\n\n__generated_with = "${MARIMO_GENERATED_WITH}"\napp = marimo.App()`,
		...blocks,
		`if __name__ == "__main__":\n    app.run()\n`,
	].join("\n\n\n");
	const sidecar: NotebookSidecar = {
		format: NOTEBOOK_SIDECAR_FORMAT,
		version: NOTEBOOK_SIDECAR_VERSION,
		...rest,
		cells: cells.map(sidecarCell),
	};
	return { py: pyText, sidecar };
}

// ─── marimo → Journal ───────────────────────────────────────────────────────

type ParsedKind =
	| { kind: "python"; code: string }
	| { kind: "md"; text: string; code: string }
	| { kind: "agent"; prompt: string; answer?: string; code: string };

interface ParsedCell {
	/** The id the cell function's name carries; null = anonymous. */
	nameId: string | null;
	shape: ParsedKind;
	/** marimo dropped this cell's name (`@app.function`, `@app.class_definition`,
	 *  `_unparsable_cell`) — not a cell the learner added. */
	stripped?: true;
}

function dedent4(lines: string[]): string {
	return lines.map((l) => l.replace(/^ {1,4}/, "")).join("\n");
}

function classify(code: string): ParsedKind {
	const trimmed = code.trim();
	if (trimmed.startsWith("mo.md(")) {
		const lit = readPyString(trimmed, skipSpace(trimmed, 6));
		if (lit) {
			const close = skipSpace(trimmed, lit.end);
			if (trimmed[close] === ")" && close === trimmed.length - 1) return { kind: "md", text: unwrapBlock(lit.value), code };
		}
	}
	const agent = /^_prompt\s*=\s*/.exec(trimmed);
	if (agent) {
		const prompt = readPyString(trimmed, agent[0].length);
		if (prompt) {
			let at = skipSpace(trimmed, prompt.end);
			let answer: string | undefined;
			const a = /^_answer\s*=\s*/.exec(trimmed.slice(at));
			if (a) {
				const lit = readPyString(trimmed, at + a[0].length);
				if (lit) {
					answer = unwrapBlock(lit.value);
					at = skipSpace(trimmed, lit.end);
				}
			}
			const display = trimmed.slice(at).replace(/\s+/g, "").replace(/'/g, '"');
			const expected = (answer !== undefined ? AGENT_DISPLAY : AGENT_DISPLAY_NO_ANSWER).replace(/\s+/g, "");
			if (display === expected) return { kind: "agent", prompt: unwrapBlock(prompt.value), ...(answer !== undefined ? { answer } : {}), code };
		}
	}
	return { kind: "python", code };
}

/** A single fenced block → its info string and body; null otherwise. */
function parseFence(text: string): { lang: string; source: string } | null {
	const lines = text.split("\n");
	if (lines.length < 2) return null;
	const open = /^(`{3,})([^`]*)$/.exec(lines[0]!);
	if (!open || lines[lines.length - 1]!.trimEnd() !== open[1]) return null;
	const body = lines.slice(1, -1);
	if (body.some((l) => new RegExp(`^\`{${open[1]!.length},}\\s*$`).test(l))) return null;
	return { lang: open[2]!.trim(), source: body.join("\n") };
}

/** Split the .py into cells (line-based: marimo indents all cell code, so
 *  a non-blank column-0 line always starts the next top-level block). */
export function parseMarimoCells(py: string): { cells: ParsedCell[]; appTitle?: string } {
	// A file whose every line ends in CRLF (git autocrlf) reads as LF; a lone
	// CR inside a cell's own code is kept.
	const crlf = py.includes("\r\n") && !/(^|[^\r])\n/.test(py);
	const lines = (crlf ? py.replace(/\r\n/g, "\n") : py).split("\n");
	const cells: ParsedCell[] = [];
	let appTitle: string | undefined;
	// A closing bracket at column 0 continues the statement above it
	// (marimo wraps long signatures as `def _(\n    a,\n):`).
	const isTop = (l: string) => l !== "" && !/^[\s)\]]/.test(l);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (!isTop(line)) {
			i++;
			continue;
		}
		// The block: this line up to the next top-level line, but a decorator
		// owns the def under it.
		let end = i + 1;
		const extend = () => {
			while (end < lines.length && !isTop(lines[end]!)) end++;
		};
		extend();
		if (line.startsWith("@")) {
			// Decorators (one may span lines: `@app.cell(\n    hide_code=True\n)`)
			// own the def under them.
			let k = end;
			while (k < lines.length && !/^(async\s+)?(def|class)\s/.test(lines[k]!) && (!isTop(lines[k]!) || /^[)@]/.test(lines[k]!))) k++;
			if (k < lines.length && /^(async\s+)?(def|class)\s/.test(lines[k]!)) {
				end = k + 1;
				extend();
			}
		}
		const block = lines.slice(i, end);
		while (block.length && block[block.length - 1]!.trim() === "") block.pop();
		i = end;

		if (line.startsWith("app = marimo.App(") || line.startsWith("app=marimo.App(")) {
			const text = block.join("\n");
			const t = /app_title\s*=\s*/.exec(text);
			const lit = t ? readPyString(text, t.index + t[0].length) : null;
			if (lit) appTitle = lit.value;
			continue;
		}
		if (/^@app\.cell\b/.test(line)) {
			const defAt = block.findIndex((l) => /^(async\s+)?def\s/.test(l));
			if (defAt < 0) continue;
			const name = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(block[defAt]!)?.[1] ?? "_";
			// Signature: up to the line closing its parentheses with ':'.
			let depth = 0;
			let sigEnd = defAt;
			for (let k = defAt; k < block.length; k++) {
				for (const c of block[k]!) depth += c === "(" ? 1 : c === ")" ? -1 : 0;
				if (depth <= 0 && /:\s*$/.test(block[k]!)) {
					sigEnd = k;
					break;
				}
			}
			let body = block.slice(sigEnd + 1);
			// The generated return: the last 4-space `return`, with only its
			// own continuation lines after it.
			for (let k = body.length - 1; k >= 0; k--) {
				if (/^ {4}return(\s|\(|$)/.test(body[k]!)) {
					if (body.slice(k + 1).every((l) => /^ {5,}\S|^ {4}[)\]]|^\s*$/.test(l))) body = body.slice(0, k);
					break;
				}
				if (!/^ {5,}\S|^ {4}[)\]]|^\s*$/.test(body[k]!)) break;
			}
			const code = dedent4(body);
			const shape = classify(code);
			const nameId = cellIdFromFnName(name);
			if (nameId === null && shape.kind === "python" && code.trim() === MO_IMPORT) continue; // the generated setup cell
			cells.push({ nameId, shape });
			continue;
		}
		if (line.startsWith("app._unparsable_cell(")) {
			const text = block.join("\n");
			const lit = readPyString(text, skipSpace(text, "app._unparsable_cell(".length));
			if (!lit) continue;
			let v = lit.value;
			if (v.startsWith("\n")) v = v.slice(1);
			v = v.replace(/\n[ \t]*$/, "");
			const nameM = /name\s*=\s*/.exec(text.slice(lit.end));
			const nameLit = nameM ? readPyString(text, lit.end + nameM.index + nameM[0].length) : null;
			cells.push({ nameId: nameLit ? cellIdFromFnName(nameLit.value) : null, shape: { kind: "python", code: dedent4(v.split("\n")) }, stripped: true });
			continue;
		}
		if (/^@app\.(function|class_definition)\b/.test(line)) {
			// The whole def is the cell's code, at column 0 (no dedent).
			cells.push({ nameId: null, shape: { kind: "python", code: block.filter((l) => !/^@app\./.test(l)).join("\n") }, stripped: true });
			continue;
		}
		if (/^with\s+app\.setup\b/.test(line)) {
			cells.push({ nameId: null, shape: { kind: "python", code: dedent4(block.slice(1)) } });
			continue;
		}
		// import marimo, __generated_with, `if __name__ …`, anything else: not a cell.
	}
	return { cells, ...(appTitle !== undefined ? { appTitle } : {}) };
}

export interface MarimoReadOptions {
	/** The journal id when the sidecar is missing (the store's file name). */
	id?: string;
	/** Timestamp for cells new to the sidecar and for hand-edited text
	 *  (the store passes the .py's mtime). */
	now?: string;
	/** Fresh ids for cells that carry none. Default: deterministic, from
	 *  the cell's position and text. */
	newCellId?: (index: number, text: string) => string;
}

export interface MarimoReadResult {
	journal: Journal;
	/** True when some cell's id is not the one its function name carries
	 *  (anonymous, duplicated, re-attached): the .py must be rewritten so
	 *  the ids stay stable. */
	idsChanged: boolean;
}

function isSidecar(x: unknown): x is NotebookSidecar {
	return typeof x === "object" && x !== null && Array.isArray((x as { cells?: unknown }).cells);
}

const trimTrailingBlankLines = (s: string) => s.replace(/(\n[ \t]*)+$/, "");

/** The text a parsed cell carries, for a given sidecar role guess. */
function candidateText(shape: ParsedKind, meta: NotebookSidecarCell | undefined): string[] {
	if (shape.kind !== "python" && meta?.role === "code" && isPythonCell(meta)) return [shape.code, trimTrailingBlankLines(shape.code)];
	if (shape.kind === "agent") return [shape.prompt];
	if (shape.kind === "md") {
		if (meta?.role === "code") {
			const f = parseFence(shape.text);
			if (f) return [f.source];
		}
		return [shape.text];
	}
	const t = trimTrailingBlankLines(shape.code);
	return t === shape.code ? [t] : [shape.code, t];
}

/**
 * One Journal cell from a parsed cell and its sidecar entry. The sidecar's
 * fields are kept as they are (lossless) unless the cell's shape in the
 * .py now says something else — then the shape wins and fields that no
 * longer apply (a run counter on markdown, …) are dropped.
 */
function buildCell(parsedShape: ParsedKind, id: string, meta: NotebookSidecarCell | undefined, now: string): { cell: JournalCell; edited: boolean } {
	const metaPython = meta?.role === "code" && isPythonCell(meta);
	let shape = parsedShape;
	// Python code that happens to look like a markdown or agent cell (a
	// learner's own `mo.md(...)`) stays Python while its text is unchanged.
	if (metaPython && shape.kind !== "python" && [shape.code, trimTrailingBlankLines(shape.code)].some((t) => textHash(t) === meta!.sourceHash)) {
		shape = { kind: "python", code: shape.code };
	}
	let rest: Omit<JournalCell, "id" | "role" | "source">;
	if (meta) {
		const { id: _id, role: _role, sourceHash: _hash, ...m } = meta;
		rest = m;
	} else rest = { publish: false, createdAt: now, updatedAt: now };
	const dropCodeFields = () => {
		delete rest.lang;
		delete rest.output;
		delete rest.executionCount;
	};

	let role: JournalCellRole;
	let source: string;
	if (shape.kind === "python") {
		role = "code";
		const trimmed = trimTrailingBlankLines(shape.code);
		source = meta && textHash(shape.code) === meta.sourceHash ? shape.code : trimmed;
		if (!metaPython) {
			dropCodeFields();
			rest.lang = "python";
		}
	} else if (shape.kind === "agent") {
		role = "agent";
		source = shape.prompt;
		if (meta?.role !== "agent") dropCodeFields();
		if (shape.answer !== undefined) rest.output = shape.answer;
		else delete rest.output;
	} else {
		const f = parseFence(shape.text);
		const fenceLang = f && f.lang && runnableLang(f.lang) !== "python" ? f.lang : null;
		if (meta?.role === "code" && !metaPython && fenceLang !== null) {
			role = "code";
			source = f!.source;
			if (fenceLang !== (meta.lang ?? "").trim()) rest.lang = fenceLang; // the fence was edited
		} else if (meta && MARKDOWN_ROLES.includes(meta.role)) {
			role = meta.role;
			source = shape.text;
		} else if (!meta && fenceLang !== null) {
			role = "code"; // a lone ```lang block added in marimo: a code cell
			source = f!.source;
			rest.lang = fenceLang;
		} else {
			role = "reflection";
			source = shape.text;
			if (meta) dropCodeFields();
		}
	}
	if (!meta) rest.publish = DEFAULT_PUBLISH[role];

	const edited = meta !== undefined && (textHash(source) !== meta.sourceHash || meta.role !== role);
	const cell: JournalCell = { id, role, source, ...rest };
	if (edited) cell.updatedAt = now;
	return { cell, edited };
}

function defaultNewCellId(index: number, text: string, salt: number): string {
	return `cell_${textHash(`${salt}:${index}:${text}`).slice(-12)}`;
}

/**
 * Read a marimo `.py` + sidecar back into a Journal. Tolerates hand edits:
 * reordered cells (matched by function name = id), edited text (the cell's
 * updatedAt moves to `now`), cells added in marimo (fresh id, default
 * metadata, role from the cell's shape), and cells deleted there (their
 * sidecar entries are dropped).
 */
export function readMarimoNotebook(py: string, sidecar: unknown, opts: MarimoReadOptions = {}): MarimoReadResult {
	const now = opts.now ?? new Date(0).toISOString();
	const sc = isSidecar(sidecar) ? sidecar : null;
	const parsed = parseMarimoCells(py);
	const metaById = new Map((sc?.cells ?? []).filter((c) => typeof c?.id === "string").map((c) => [c.id, c]));

	// 1. Named cells claim their ids (first one wins a duplicated name).
	const ids: (string | null)[] = [];
	const claimed = new Set<string>();
	for (const p of parsed.cells) {
		const id = p.nameId !== null && !claimed.has(p.nameId) ? p.nameId : null;
		if (id) claimed.add(id);
		ids.push(id);
	}
	// 2. Anonymous cells re-attach to an unclaimed sidecar entry with the same text.
	parsed.cells.forEach((p, i) => {
		if (ids[i] !== null) return;
		for (const meta of metaById.values()) {
			if (claimed.has(meta.id)) continue;
			if (candidateText(p.shape, meta).some((t) => textHash(t) === meta.sourceHash)) {
				ids[i] = meta.id;
				claimed.add(meta.id);
				return;
			}
		}
	});
	// 2b. marimo strips names itself: a cell that is only a function / class
	// is saved as `@app.function` / `@app.class_definition`, an unparsable
	// one as `_unparsable_cell(name="_")`. When that cell was also edited, the
	// text no longer matches; if exactly one such cell and exactly one
	// unclaimed Python sidecar entry are left, they are the same cell.
	const stripped = parsed.cells.map((p, i) => i).filter((i) => ids[i] === null && parsed.cells[i]!.stripped);
	const orphans = [...metaById.values()].filter((m) => !claimed.has(m.id) && m.role === "code" && isPythonCell(m));
	if (stripped.length === 1 && orphans.length === 1) {
		ids[stripped[0]!] = orphans[0]!.id;
		claimed.add(orphans[0]!.id);
	}
	// 3. The rest get fresh ids.
	parsed.cells.forEach((p, i) => {
		if (ids[i] !== null) return;
		const text = candidateText(p.shape, undefined)[0]!;
		let salt = 0;
		let id = opts.newCellId ? opts.newCellId(i, text) : defaultNewCellId(i, text, salt);
		while (claimed.has(id)) id = defaultNewCellId(i, text, ++salt);
		ids[i] = id;
		claimed.add(id);
	});

	let changed = false;
	const cells = parsed.cells.map((p, i) => {
		const id = ids[i]!;
		const meta = metaById.get(id);
		if (!meta) changed = true;
		const { cell, edited } = buildCell(p.shape, id, meta, now);
		if (edited) changed = true;
		return cell;
	});
	if (sc && sc.cells.length !== cells.length) changed = true;
	if (sc && sc.cells.some((c, i) => c.id !== cells[i]?.id)) changed = true;

	const idsChanged = parsed.cells.some((p, i) => p.nameId !== ids[i]);
	let journal: Journal;
	if (sc) {
		const { format: _f, version: _v, cells: _c, ...rest } = sc;
		journal = { ...rest, cells };
	} else {
		const title = parsed.appTitle?.trim() || "Untitled notebook";
		journal = {
			id: opts.id ?? `jrnl_${textHash(py).slice(-12)}`,
			title,
			slug: slugify(title),
			tags: [],
			cells,
			publications: [],
			createdAt: now,
			updatedAt: now,
		};
	}
	if (opts.id !== undefined) journal.id = opts.id;
	if (sc && changed && now > journal.updatedAt) journal.updatedAt = now;
	return { journal, idsChanged };
}

/** marimo `.py` + sidecar → Journal (readMarimoNotebook without the
 *  repair flag). */
export function marimoToJournal(py: string, sidecar: unknown, opts: MarimoReadOptions = {}): Journal {
	return readMarimoNotebook(py, sidecar, opts).journal;
}
