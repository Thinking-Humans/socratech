/**
 * Marimo storage (docs/learn-in-public.md "Marimo storage"): the pure
 * Journal ⇄ { .py, sidecar } serializer — lossless round-trip for every
 * role and tricky text, hand-edit tolerance (reorder, edit, add, delete,
 * marimo's own rewrite of the file), and the redefinition finder.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { Journal, JournalCell } from "../src/core/contracts/journal.ts";
import {
	cellFnName,
	cellIdFromFnName,
	journalToMarimo,
	marimoRedefinitions,
	marimoToJournal,
	parseMarimoCells,
	pyBlockString,
	pythonNames,
	readMarimoNotebook,
	readPyString,
} from "../src/core/marimo-format.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = "2026-11-15T10:00:00.000Z";
const T2 = "2026-11-15T11:00:00.000Z";

function cell(id: string, role: JournalCell["role"], source: string, extra: Partial<JournalCell> = {}): JournalCell {
	return { id, role, source, publish: role !== "aside", createdAt: T, updatedAt: T, ...extra };
}

const TRICKY = [
	'Triple """ double and \'\'\' single quotes',
	"Backslash \\ at the end \\",
	"Format braces {x} {{y}} and f-string-ish {0!r}",
	"Unicode: λ → ∞, emoji 🧠, CJK 学习, combining é",
	"",
	"\n",
	"  leading spaces\n\ttab-indented\n    four spaces\n",
	"trailing newline\n\n",
	"CR\rLF\r\nNUL\u0000bell\u0007",
	'"quoted at both ends"',
	"'''only single triples'''",
	'mix """ and \'\'\' together \\"""',
	"```cpp\nint main() {}\n```",
	"r\"\"\" fake raw prefix",
	"# a heading\n\n$$\\sum_i x_i$$ and $\\alpha$",
];

function sample(): Journal {
	return {
		id: "jrnl_test_1",
		title: 'Spectral "graph" notes',
		slug: "spectral-graph-notes",
		chatId: "chat_x",
		tags: ["linear algebra"],
		cells: [
			cell("cell_000000000001", "exercise", "Show $L$ is PSD.", { origin: { chatId: "chat_x", toolCallId: "p1", ideaIds: ["n_lap"] } }),
			cell("cell_000000000002", "attempt", "Sum of squares.", { publish: false }),
			cell("cell_000000000003", "verdict", "**Pass.**", { publish: false }),
			cell("cell_000000000004", "reflection", "I learned *why*.", {
				understanding: { level: "helped", hash: "abc", at: T, check: { question: "q?", answer: "a", verdict: "holds", rationale: "ok", at: T } },
				graph: { hash: "h", at: T, nodes: 2, chains: 1 },
			}),
			cell("cell_000000000005", "aside", "private aside", { publish: false }),
			cell("cell_000000000006", "code", "import numpy as np\nL = np.eye(2)\nprint(L)", { lang: "python", output: "[[1. 0.]\n [0. 1.]]\n", executionCount: 3 }),
			cell("cell_000000000007", "code", "print(L.sum())\nnp.linalg.eigvalsh(L)", { lang: "py", output: "2.0", executionCount: 4 }),
			cell("cell_000000000008", "code", '#include <cstdio>\nint main() { std::puts("```"); }', { lang: "cpp", output: "```\n", executionCount: 5 }),
			cell("cell_000000000009", "agent", "Explain the Fiedler vector.", { output: "It is the eigenvector of $\\lambda_2$." }),
			cell("cell_00000000000a", "agent", "Not run yet."),
			cell("cell_00000000000b", "code", "no lang set"),
			cell("cell_00000000000c", "code", "fn main() {}", { lang: "rust", output: "pasted" }),
			...TRICKY.map((text, i) => cell(`cell_tricky${String(i).padStart(2, "0")}`, i % 2 ? "reflection" : "agent", text, i % 2 ? {} : { output: TRICKY[TRICKY.length - 1 - i]! })),
			...TRICKY.map((text, i) => cell(`cell_code${String(i).padStart(2, "0")}`, "code", text, { lang: i % 2 ? "cpp" : "python" })),
			// Python that looks like the generated shapes stays Python.
			cell("cell_lookalike1", "code", 'mo.md(r"""\nhi\n""")', { lang: "python", output: "md", executionCount: 7 }),
			cell("cell_lookalike2", "code", '_prompt = r"""\nq\n"""\nmo.callout(mo.md(_prompt), kind="info")\n', { lang: "python", executionCount: 8 }),
			cell("cell_lookalike3", "code", "import marimo as mo", { lang: "python" }),
			cell("odd-id/with spaces", "reflection", "non-identifier id"),
			cell("c_looks_escaped", "reflection", "id starting c_"),
			cell("app", "reflection", "reserved id"),
		],
		publications: [{ at: T, siteRepo: "/site", path: "content/posts/2026-11-15-x", url: "https://x/y", commit: "abc" }],
		createdAt: T,
		updatedAt: T2,
	};
}

describe("marimo format: round-trip", () => {
	it("journal → { py, sidecar } → journal is lossless for every role and tricky text", () => {
		const j = sample();
		const { py, sidecar } = journalToMarimo(j);
		const back = readMarimoNotebook(py, JSON.parse(JSON.stringify(sidecar)), { now: "2099-01-01T00:00:00.000Z" });
		assert.deepEqual(back.journal, j);
		assert.equal(back.idsChanged, false);
		// Deterministic: the same journal always gives the same bytes.
		assert.equal(journalToMarimo(back.journal).py, py);
	});

	it("unknown top-level and cell fields ride along in the sidecar", () => {
		const j = { ...sample(), graph: { hash: "jh", at: T, nodes: 5, chains: 2 }, futureField: { x: 1 } } as Journal;
		j.cells[0] = { ...j.cells[0]!, futureCellField: [1, 2] } as JournalCell;
		const { py, sidecar } = journalToMarimo(j);
		assert.deepEqual(marimoToJournal(py, JSON.parse(JSON.stringify(sidecar))), j);
	});

	it("readable text lives in the .py; the sidecar has no source and no agent answer", () => {
		const { py, sidecar } = journalToMarimo(sample());
		assert.match(py, /^import marimo\n\n__generated_with = "[\d.]+"\napp = marimo\.App\(\)\n/);
		assert.match(py, /\nif __name__ == "__main__":\n {4}app\.run\(\)\n$/);
		assert.match(py, /@app\.cell\(hide_code=True\)\ndef cell_000000000004\(mo\):\n {4}mo\.md\(r"""\n {4}I learned \*why\*\.\n {4}"""\)\n {4}return/);
		assert.match(py, /def cell_000000000006\(\):\n {4}import numpy as np\n {4}L = np\.eye\(2\)\n {4}print\(L\)\n {4}return \(L, np\)/);
		assert.match(py, /def cell_000000000007\(L, np\):/);
		assert.match(py, /````cpp\n {4}#include <cstdio>/);
		assert.match(py, /_prompt = r"""\n {4}Explain the Fiedler vector\.\n {4}"""\n {4}_answer = r"""\n {4}It is the eigenvector/);
		const text = JSON.stringify(sidecar);
		assert.equal(text.includes("Fiedler"), false);
		assert.equal(text.includes("I learned"), false);
		assert.equal(sidecar.cells.find((c) => c.id === "cell_000000000006")!.output, "[[1. 0.]\n [0. 1.]]\n");
		assert.equal(sidecar.format, "socratech-notebook");
		assert.equal(sidecar.version, 1);
	});

	it("cell ids: safe ids are the function name, the rest escape reversibly", () => {
		for (const id of ["cell_3f2a9b1c0d4e", "c1", "odd-id/with spaces", "c_x", "_x", "app", "mo", "class", "ünï", "a_5f_b"]) {
			const name = cellFnName(id);
			assert.match(name, /^[A-Za-z_]\w*$/, id);
			assert.equal(cellIdFromFnName(name), id, id);
		}
		assert.equal(cellFnName("cell_3f2a9b1c0d4e"), "cell_3f2a9b1c0d4e");
		assert.equal(cellIdFromFnName("_"), null);
	});

	it("string literals: the writer's output reads back exactly", () => {
		for (const t of TRICKY) {
			const lit = pyBlockString(t);
			const r = readPyString(lit, 0);
			assert.ok(r, lit);
			assert.equal(r.value, `\n${t}\n`);
			assert.equal(r.end, lit.length);
		}
		assert.match(pyBlockString("plain"), /^r"""/);
		assert.match(pyBlockString('has """'), /^r'''/);
		assert.match(pyBlockString("both \"\"\" '''"), /^"""/);
		assert.match(pyBlockString("cr\r"), /^"""/);
		assert.equal(readPyString(String.raw`"a\x41é\U0001F600\101\n\q"`, 0)!.value, "aAé😀A\n\\q");
		assert.equal(readPyString(String.raw`r"a\"b"`, 0)!.value, 'a\\"b');
		assert.equal(readPyString('f"x"', 0), null);
	});
});

describe("marimo format: Python names", () => {
	it("module-level defs and refs, skipping locals and _private names", () => {
		const { defs, refs } = pythonNames(
			[
				"import numpy as np, os.path",
				"from math import (sqrt, pi as PI)",
				"x, (y, *z) = 1, (2, 3)",
				"w: int = 4",
				"count += 1",
				"_hidden = 5",
				"def f(a, b=2):",
				"    local = a + b",
				"    return local",
				"class K:",
				"    attr = 1",
				"for i in range(3):",
				"    acc = i",
				"if (n := len(data)) > 0:",
				"    flag = True",
				"with open(p) as fh:",
				"    s = '''x = 1'''  # not a def",
				"print(L.shape, other.attr, f(x=1))",
			].join("\n"),
		);
		assert.deepEqual(defs, ["K", "PI", "acc", "count", "f", "fh", "flag", "i", "n", "np", "os", "s", "sqrt", "w", "x", "y", "z"]);
		for (const r of ["L", "data", "other", "p", "range", "print", "len", "open"]) assert.ok(refs.includes(r), r);
		// Function / class locals still count as refs: the writer only keeps refs
		// that another cell defines, so they never reach a signature.
		for (const r of ["shape", "_hidden", "x", "s"]) assert.ok(!refs.includes(r), r);
	});

	it("marimoRedefinitions: names defined by two cells, and `mo`", () => {
		assert.deepEqual(
			marimoRedefinitions([
				{ id: "a", defs: ["x", "y", "_tmp"] },
				{ id: "b", defs: ["x", "mo", "_tmp"] },
				{ id: "c", defs: ["y", "z"] },
			]),
			[
				{ name: "mo", cellIds: ["b"], reserved: true },
				{ name: "x", cellIds: ["a", "b"] },
				{ name: "y", cellIds: ["a", "c"] },
			],
		);
	});
});

describe("marimo format: hand edits", () => {
	const base = (): Journal => ({
		id: "jrnl_h",
		title: "Hand",
		slug: "hand",
		tags: [],
		cells: [
			cell("cell_a00000000001", "reflection", "First."),
			cell("cell_a00000000002", "code", "x = 1", { lang: "python", output: "", executionCount: 1 }),
			cell("cell_a00000000003", "code", "print(x)", { lang: "python", output: "1\n", executionCount: 2 }),
			cell("cell_a00000000004", "aside", "Aside.", { publish: false }),
		],
		publications: [],
		createdAt: T,
		updatedAt: T,
	});
	const blocks = (py: string) => py.split("\n\n\n");

	it("reordered cells keep their ids and metadata", () => {
		const { py, sidecar } = journalToMarimo(base());
		const b = blocks(py); // [header, mo, c1, c2, c3, c4, footer]
		const reordered = [b[0], b[1], b[5], b[4], b[2], b[3], b[6]].join("\n\n\n");
		const r = readMarimoNotebook(reordered, sidecar, { now: T2 });
		assert.deepEqual(r.journal.cells.map((c) => c.id), ["cell_a00000000004", "cell_a00000000003", "cell_a00000000001", "cell_a00000000002"]);
		assert.equal(r.journal.cells[1]!.output, "1\n");
		assert.equal(r.journal.cells[0]!.publish, false);
		assert.equal(r.idsChanged, false);
		assert.equal(r.journal.updatedAt, T2, "a reorder is a change");
	});

	it("edited text: new text wins, the cell's updatedAt moves, metadata stays", () => {
		const { py, sidecar } = journalToMarimo(base());
		const r = readMarimoNotebook(py.replace("First.", "First, edited in marimo."), sidecar, { now: T2 });
		const c = r.journal.cells[0]!;
		assert.equal(c.source, "First, edited in marimo.");
		assert.equal(c.updatedAt, T2);
		assert.equal(c.createdAt, T);
		assert.equal(r.journal.cells[1]!.updatedAt, T);
	});

	it("a cell added in marimo gets an id and default metadata; a deleted one leaves the sidecar", () => {
		const { py, sidecar } = journalToMarimo(base());
		const b = blocks(py);
		const added = '@app.cell\ndef _(x):\n    y = x * 2\n    return (y,)';
		const addedMd = '@app.cell(hide_code=True)\ndef _(mo):\n    mo.md(r"""\n    ## New *heading*\n    """)\n    return';
		const addedCpp = '@app.cell(hide_code=True)\ndef _(mo):\n    mo.md(r"""\n    ```cpp\n    int x;\n    ```\n    """)\n    return';
		const edited = [b[0], b[1], b[2], b[3], added, addedMd, addedCpp, b[5], b[6]].join("\n\n\n"); // cell 3 deleted
		const r = readMarimoNotebook(edited, sidecar, { now: T2 });
		const cells = r.journal.cells;
		assert.equal(cells.length, 6);
		assert.equal(r.idsChanged, true);
		assert.ok(!cells.some((c) => c.id === "cell_a00000000003"));
		const [py2, md2, cpp2] = [cells[2]!, cells[3]!, cells[4]!];
		assert.match(py2.id, /^cell_[0-9a-f]{12}$/);
		assert.deepEqual([py2.role, py2.lang, py2.source, py2.publish, py2.createdAt], ["code", "python", "y = x * 2", true, T2]);
		assert.deepEqual([md2.role, md2.source, md2.publish], ["reflection", "## New *heading*", true]);
		assert.deepEqual([cpp2.role, cpp2.lang, cpp2.source], ["code", "cpp", "int x;"]);
		// Stable: reading the same file again mints the same ids.
		assert.deepEqual(readMarimoNotebook(edited, sidecar, { now: T2 }).journal.cells.map((c) => c.id), cells.map((c) => c.id));
		// After the store writes the repaired notebook back, it reads cleanly.
		const healed = journalToMarimo(r.journal);
		const again = readMarimoNotebook(healed.py, healed.sidecar, { now: "2099-01-01T00:00:00.000Z" });
		assert.equal(again.idsChanged, false);
		assert.deepEqual(again.journal, r.journal);
	});

	it("a duplicated cell name (copy in marimo): the first keeps the id", () => {
		const { py, sidecar } = journalToMarimo(base());
		const b = blocks(py);
		const r = readMarimoNotebook([b[0], b[1], b[2], b[2]!.replace("First.", "Copy."), b[6]].join("\n\n\n"), sidecar, { now: T2 });
		assert.equal(r.journal.cells[0]!.id, "cell_a00000000001");
		assert.notEqual(r.journal.cells[1]!.id, "cell_a00000000001");
		assert.equal(r.idsChanged, true);
	});

	it("a cell whose name marimo dropped (unparsable) re-attaches by its text", () => {
		const j = base();
		j.cells[2] = { ...j.cells[2]!, source: "def broken(:\n    pass" };
		const { sidecar } = journalToMarimo(j);
		const py = journalToMarimo(j).py.replace(
			/@app\.cell\ndef cell_a00000000003\(\):\n {4}def broken\(:\n {8}pass\n {4}return/,
			'app._unparsable_cell(\n    r"""\n    def broken(:\n        pass\n    """,\n    name="_"\n)',
		);
		assert.match(py, /_unparsable_cell/);
		const r = readMarimoNotebook(py, sidecar, { now: T2 });
		assert.equal(r.journal.cells[2]!.id, "cell_a00000000003");
		assert.equal(r.journal.cells[2]!.output, "1\n");
		assert.equal(r.journal.cells[2]!.source, "def broken(:\n    pass");
	});

	it("a function-only cell marimo saved as @app.function keeps its id, edited or not", () => {
		const j = base();
		j.cells[1] = { ...j.cells[1]!, source: "def double(x):\n    return x * 2" };
		const { py, sidecar } = journalToMarimo(j);
		// What `marimo check --fix` (0.25.2) writes for such a cell: the name is gone.
		const asFunction = (src: string) =>
			py.replace(/@app\.cell\ndef cell_a00000000002\(\):\n {4}def double\(x\):\n {8}return x \* 2\n {4}return \(double,\)/, `@app.function\n${src}`);
		const same = readMarimoNotebook(asFunction("def double(x):\n    return x * 2"), sidecar, { now: T2 });
		assert.notEqual(asFunction("x"), py);
		assert.deepEqual(same.journal.cells[1], j.cells[1]);
		const edited = readMarimoNotebook(asFunction("def double(x):\n    return x + x"), sidecar, { now: T2 });
		assert.equal(edited.journal.cells[1]!.id, "cell_a00000000002");
		assert.equal(edited.journal.cells[1]!.source, "def double(x):\n    return x + x");
		assert.equal(edited.journal.cells[1]!.executionCount, 1);
		assert.equal(edited.journal.cells[1]!.updatedAt, T2);
	});

	it("no sidecar: a plain marimo notebook still loads", () => {
		const py = [
			"import marimo",
			'__generated_with = "0.25.2"',
			'app = marimo.App(width="medium", app_title="From marimo")',
			"@app.cell\ndef _():\n    import marimo as mo\n    return (mo,)",
			'@app.cell\ndef _(mo):\n    mo.md(r"""\n    # Hello\n    """)\n    return',
			"@app.cell\ndef _():\n    a = 1\n    return (a,)",
			'if __name__ == "__main__":\n    app.run()',
		].join("\n\n\n");
		const j = marimoToJournal(py, null, { id: "jrnl_m", now: T });
		assert.equal(j.id, "jrnl_m");
		assert.equal(j.title, "From marimo");
		assert.equal(j.slug, "from-marimo");
		assert.deepEqual(j.cells.map((c) => [c.role, c.source]), [["reflection", "# Hello"], ["code", "a = 1"]]);
	});

	it("marimo's own rewrite of a generated file reads back to the same journal (fixture)", () => {
		// tests/fixtures/marimo/notebook.py is journalToMarimo's output (it
		// passes `uvx marimo check` and runs under `marimo export html`);
		// notebook.marimo-fixed.py is the same file after `uvx marimo check
		// --fix` (marimo 0.25.2): regenerated signatures and returns, a blank
		// line before `return`, a wrapped arg list — and marimo's markdown
		// fixer rewriting the one r'''…''' cell to r"""…""" with `"""`
		// escaped as `"\""` (renders the same; the text gains a backslash).
		const dir = path.join(HERE, "fixtures", "marimo");
		const sidecar = JSON.parse(fs.readFileSync(path.join(dir, "notebook.socratech.json"), "utf-8"));
		const original = marimoToJournal(fs.readFileSync(path.join(dir, "notebook.py"), "utf-8"), sidecar);
		assert.equal(original.cells.length, 11);
		const fixedPy = fs.readFileSync(path.join(dir, "notebook.marimo-fixed.py"), "utf-8");
		const fixed = readMarimoNotebook(fixedPy, sidecar, { now: T2 });
		assert.equal(fixed.idsChanged, false);
		assert.deepEqual(fixed.journal.cells.slice(1), original.cells.slice(1));
		assert.equal(fixed.journal.cells[0]!.id, original.cells[0]!.id);
		assert.equal(fixed.journal.cells[0]!.source, original.cells[0]!.source.replace('"""', '"\\""'));
		assert.equal(fixed.journal.cells[0]!.updatedAt, T2);
		assert.equal(parseMarimoCells(fixedPy).cells.length, original.cells.length);
	});
});
