/**
 * marimo-clean check (docs/learn-in-public.md "Marimo storage"). Socratech
 * runs Python cells in its own kernel, where redefining a global in a
 * second cell is fine; marimo refuses such a notebook. This reads each
 * Python cell with python3's own `ast` (python3 is already required for
 * the kernel) and reports:
 *
 *   redefinitions  globals two Python cells both define (and any cell
 *                  defining `mo`, which the notebook's import cell owns)
 *   unparsable     cells marimo cannot parse (syntax errors)
 *
 * Bindings counted as marimo does: module-level assignment / augmented /
 * annotated targets, imports, def / class names, for / with / except /
 * match targets, walrus; never function or comprehension locals, never
 * `_`-prefixed names (cell-local in marimo). Advisory only: a run never
 * fails because of it. Results are cached by the cells' text.
 */

import { spawn } from "node:child_process";
import { isPythonCell, marimoRedefinitions, type MarimoRedefinition } from "../core/marimo-format.ts";
import { textHash } from "../core/notebook-learning.ts";
import type { Journal } from "../core/contracts/journal.ts";

export interface MarimoCleanReport {
	/** False when python3 could not be run — nothing was checked. */
	checked: boolean;
	redefinitions: MarimoRedefinition[];
	unparsable: { cellId: string; error: string }[];
}

const AST_DEFS = String.raw`
import ast, json, sys

class Defs(ast.NodeVisitor):
    def __init__(self):
        self.names = set()
    def visit_FunctionDef(self, n):
        for d in n.decorator_list: self.visit(d)
        self.names.add(n.name)
    visit_AsyncFunctionDef = visit_FunctionDef
    def visit_ClassDef(self, n):
        for d in n.decorator_list: self.visit(d)
        self.names.add(n.name)
    def visit_Lambda(self, n): pass
    def visit_ListComp(self, n): pass
    visit_SetComp = visit_DictComp = visit_GeneratorExp = visit_ListComp
    def visit_Name(self, n):
        if isinstance(n.ctx, ast.Store): self.names.add(n.id)
    def visit_Import(self, n):
        for a in n.names: self.names.add(a.asname or a.name.split(".")[0])
    def visit_ImportFrom(self, n):
        for a in n.names:
            if a.name != "*": self.names.add(a.asname or a.name)
    def visit_ExceptHandler(self, n):
        if n.name: self.names.add(n.name)
        self.generic_visit(n)
    def visit_MatchAs(self, n):
        if n.name: self.names.add(n.name)
        self.generic_visit(n)
    def visit_MatchStar(self, n):
        if n.name: self.names.add(n.name)
    def visit_MatchMapping(self, n):
        if n.rest: self.names.add(n.rest)
        self.generic_visit(n)

out = []
for c in json.load(sys.stdin):
    try:
        tree = ast.parse(c["code"])
    except SyntaxError as e:
        out.append({"id": c["id"], "ok": False, "error": "%s (line %s)" % (e.msg, e.lineno)})
        continue
    v = Defs()
    v.visit(tree)
    out.append({"id": c["id"], "ok": True, "defs": sorted(d for d in v.names if not d.startswith("_"))})
json.dump(out, sys.stdout)
`;

type AstResult = { id: string; ok: true; defs: string[] } | { id: string; ok: false; error: string };

const cache = new Map<string, MarimoCleanReport>();
const CACHE_MAX = 64;

function runAst(cells: { id: string; code: string }[]): Promise<AstResult[] | null> {
	return new Promise((resolve) => {
		let out = "";
		let done = false;
		const finish = (v: AstResult[] | null) => {
			if (done) return;
			done = true;
			resolve(v);
		};
		let child;
		try {
			child = spawn(process.env.LH_PYTHON || "python3", ["-I", "-c", AST_DEFS], { stdio: ["pipe", "pipe", "ignore"], timeout: 10_000 });
		} catch {
			return finish(null);
		}
		child.on("error", () => finish(null));
		child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
		child.on("close", (code) => {
			if (code !== 0) return finish(null);
			try {
				finish(JSON.parse(out) as AstResult[]);
			} catch {
				finish(null);
			}
		});
		child.stdin.on("error", () => finish(null));
		child.stdin.end(JSON.stringify(cells));
	});
}

/** The marimo-clean report for a notebook's Python cells. */
export async function marimoCleanCheck(journal: Pick<Journal, "cells">): Promise<MarimoCleanReport> {
	const cells = journal.cells.filter(isPythonCell).map((c) => ({ id: c.id, code: c.source }));
	const key = textHash(JSON.stringify(cells));
	const hit = cache.get(key);
	if (hit) return hit;
	if (cells.length === 0) return { checked: true, redefinitions: [], unparsable: [] };
	const results = await runAst(cells);
	if (!results) return { checked: false, redefinitions: [], unparsable: [] };
	const report: MarimoCleanReport = {
		checked: true,
		redefinitions: marimoRedefinitions(results.filter((r) => r.ok).map((r) => ({ id: r.id, defs: (r as { defs: string[] }).defs }))),
		unparsable: results.filter((r): r is Extract<AstResult, { ok: false }> => !r.ok).map((r) => ({ cellId: r.id, error: r.error })),
	};
	if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
	cache.set(key, report);
	return report;
}
