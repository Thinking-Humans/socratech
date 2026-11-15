/**
 * Runnable journal cells + cell /ask (owner, 2026-11-15 — reverses D8):
 * the pure helpers, the notebook export of runs, and the local runner
 * (python kernel state across cells; cpp compile + run). Runner tests skip
 * when python3 / g++ are missing.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-journal-code-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { runnableLang, extractCellAsks, journalAskPrompt, askAnswerCell } = await import("../src/core/journal-code.ts");
const { newJournal, appendCell, updateCell } = await import("../src/core/journal.ts");
const { exportJournal } = await import("../src/core/journal-export.ts");
const { runCode, restartKernel, stopAllKernels } = await import("../src/server/code-runner.ts");

after(() => {
	stopAllKernels();
	fs.rmSync(TMP, { recursive: true, force: true });
});

const has = (cmd: string, arg: string) => spawnSync(cmd, [arg], { stdio: "ignore" }).status === 0;
const noPython = !has(process.env.LH_PYTHON || "python3", "--version") && "python3 not installed";
const noCxx = !has(process.env.LH_CXX || "g++", "--version") && "g++ not installed";

const NOW = "2026-11-15T10:00:00.000Z";

describe("runnableLang", () => {
	it("maps aliases to python / cpp and refuses the rest", () => {
		for (const l of ["python", "Python3", " py "]) assert.equal(runnableLang(l), "python");
		for (const l of ["cpp", "C++", "cxx", "cc"]) assert.equal(runnableLang(l), "cpp");
		for (const l of ["rust", "", undefined]) assert.equal(runnableLang(l), null);
	});
});

describe("extractCellAsks", () => {
	it("lifts /ask lines (bare or commented) and keeps the rest", () => {
		const r = extractCellAsks("x = 1\n# /ask why is x 1?\nprint(x)\n// /ask and in C++?\n/ask plain one\n");
		assert.deepEqual(r.questions, ["why is x 1?", "and in C++?", "plain one"]);
		assert.equal(r.source, "x = 1\nprint(x)");
	});
	it("leaves a cell without asks byte-identical", () => {
		const src = "a\n\n/asking is not an ask\n";
		assert.deepEqual(extractCellAsks(src), { questions: [], source: src });
	});
});

function journalWith(...cells: Array<{ id: string; role: "code" | "reflection"; source: string; lang?: string; output?: string }>) {
	let j = newJournal({ id: "jrnl_t", title: "Circles", now: NOW });
	for (const c of cells) j = appendCell(j, c, NOW);
	return j;
}

describe("journalAskPrompt", () => {
	it("shows the whole focus cell — code, language, output — and its neighbours", () => {
		const j = journalWith(
			{ id: "c1", role: "reflection", source: "Area of a circle is $\\pi r^2$." },
			{ id: "c2", role: "code", lang: "python", source: "r = 3\nr * 2", output: "6" },
			{ id: "c3", role: "reflection", source: "Next: circumference." },
		);
		const p = journalAskPrompt(j, "c2", "why 6?");
		assert.match(p, /\[FOCUS CELL\] code \(python\)\n"""\nr = 3\nr \* 2\n"""/);
		assert.match(p, /Output:\n"""\n6\n"""/);
		assert.match(p, /Cells before the focus cell:[\s\S]*pi r\^2/);
		assert.match(p, /Cells after the focus cell:[\s\S]*circumference/);
		assert.match(p, /Question about the focus cell: why 6\?$/);
	});
	it("throws on an unknown cell", () => {
		assert.throws(() => journalAskPrompt(journalWith(), "nope", "q"));
	});
	it("answer cells start with the /ask marker", () => {
		assert.equal(askAnswerCell("q?", "  a.  "), "**/ask** q?\n\na.");
	});
});

describe("notebook export of runs", () => {
	it("carries execution_count, real stdout outputs and per-cell language", () => {
		let j = journalWith(
			{ id: "p", role: "code", lang: "py", source: "print(1)", output: "1" },
			{ id: "c", role: "code", lang: "c++", source: "int main(){}" },
		);
		j = updateCell(j, "p", { executionCount: 3 }, NOW);
		const nb = JSON.parse(exportJournal(j, { date: "2026-11-15", format: "notebook" }).files["notebook.ipynb"]!);
		assert.equal(nb.cells[0].execution_count, 3);
		assert.deepEqual(nb.cells[0].outputs, [{ output_type: "stream", name: "stdout", text: ["1\n"] }]);
		assert.equal(nb.cells[0].metadata.vscode.languageId, "python");
		assert.equal(nb.cells[1].execution_count, null);
		assert.equal(nb.cells[1].metadata.vscode.languageId, "cpp");
	});
	it("executionCount 0 clears it", () => {
		let j = journalWith({ id: "p", role: "code", lang: "python", source: "1" });
		j = updateCell(j, "p", { executionCount: 2 }, NOW);
		j = updateCell(j, "p", { executionCount: 0 }, NOW);
		assert.equal("executionCount" in j.cells[0]!, false);
	});
});

describe("python kernel", { skip: noPython }, () => {
	it("shares state across cells and echoes the last expression", async () => {
		const a = await runCode("k1", "python", "x = 20\nprint('set', end='')");
		assert.deepEqual([a.output, a.ok, a.executionCount], ["set", true, 1]);
		const b = await runCode("k1", "python", "x + 22");
		assert.deepEqual([b.output, b.ok, b.executionCount], ["42", true, 2]);
	});
	it("reports a traceback that points into the cell", async () => {
		const r = await runCode("k2", "python", "def f():\n    return 1/0\nf()");
		assert.equal(r.ok, false);
		assert.match(r.output, /File "<cell 1>", line 2, in f[\s\S]*ZeroDivisionError/);
	});
	it("interrupts a cell over its time limit and keeps the session", async () => {
		await runCode("k3", "python", "keep = 'yes'");
		const slow = await runCode("k3", "python", "import time\ntime.sleep(10)", { timeoutMs: 300 });
		assert.equal(slow.ok, false);
		assert.match(slow.output, /KeyboardInterrupt[\s\S]*timed out/);
		assert.equal((await runCode("k3", "python", "keep")).output, "'yes'");
	});
	it("restart drops variables and the counter", async () => {
		await runCode("k4", "python", "gone = 1");
		restartKernel("k4");
		const r = await runCode("k4", "python", "'gone' in globals()");
		assert.deepEqual([r.output, r.executionCount], ["False", 1]);
	});
	it("survives the process exiting", async () => {
		const r = await runCode("k5", "python", "import os\nos._exit(3)");
		assert.equal(r.ok, false);
		assert.match(r.output, /state reset/);
		assert.equal((await runCode("k5", "python", "1 + 1")).output, "2");
	});
});

describe("cpp runner", { skip: noCxx }, () => {
	it("compiles and runs", async () => {
		const r = await runCode("c1", "cpp", '#include <iostream>\nint main(){ std::cout << 6 * 7; }');
		assert.deepEqual([r.output, r.ok], ["42", true]);
	});
	it("returns compile errors as output", async () => {
		const r = await runCode("c2", "cpp", "int main(){ return nope; }");
		assert.equal(r.ok, false);
		assert.match(r.output, /nope[\s\S]*\[compile failed\]/);
	});
	it("reports a non-zero exit", async () => {
		const r = await runCode("c3", "cpp", "int main(){ return 4; }");
		assert.deepEqual([r.output, r.ok], ["[exit code 4]", false]);
	});
});
