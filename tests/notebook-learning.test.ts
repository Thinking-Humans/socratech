/**
 * Notebooks as the unit of learning (owner, 2026-11-15): ratings, the
 * prerequisites cell for "stuck", the cross-check verdict parser, and
 * per-notebook graph extraction (on request / publish; edits replace).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notebook-learning-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const core = await import("../src/core/notebook-learning.ts");
const { createJournal, addJournalCell, patchJournalCell, requireJournal, setCellLearning } = await import("../src/server/journals.ts");
const learning = await import("../src/server/notebook-learning.ts");

const calls: Array<{ filePath: string; text: string }> = [];
learning.setNotesImporterForTests({
	async importNotes(input) {
		calls.push(input);
		return { nodes: 2, chains: 1 };
	},
});
after(() => {
	learning.setNotesImporterForTests(null);
	fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
	calls.length = 0;
});

function notebook(...cells: Array<{ role: "reflection" | "code" | "agent" | "aside"; source: string }>) {
	let j = createJournal({ title: "Recursion" });
	for (const c of cells) j = addJournalCell(j.id, c);
	return j;
}

describe("pure helpers", () => {
	it("textHash notices edits and is stable", () => {
		assert.equal(core.textHash("abc"), core.textHash("abc"));
		assert.notEqual(core.textHash("abc"), core.textHash("abd"));
		assert.match(core.textHash(""), /^[0-9a-f]{14}$/);
	});
	it("only the learner's own writing is graph material; media lines are dropped", () => {
		const base = { id: "c", publish: true, createdAt: "", updatedAt: "" };
		assert.equal(core.extractableText({ ...base, role: "reflection", source: "A base case stops it.\n![d](media/d-1.png)" }), "A base case stops it.");
		assert.equal(core.extractableText({ ...base, role: "agent", source: "explain", output: "…" }), null);
		assert.equal(core.extractableText({ ...base, role: "code", source: "f(1)" }), null);
		assert.equal(core.extractableText({ ...base, role: "reflection", source: "![d](media/d-1.png)" }), null);
	});
	it("verdict parsing and rating/check disagreement", () => {
		assert.deepEqual(core.parseCheckVerdict("VERDICT: fails\nMissing the base case."), { verdict: "fails", rationale: "Missing the base case." });
		assert.equal(core.parseCheckVerdict("no verdict line").verdict, "shaky");
		assert.equal(core.checkDisagrees("own", "shaky"), true);
		assert.equal(core.checkDisagrees("helped", "fails"), false);
		assert.equal(core.checkDisagrees("stuck", "holds"), true);
	});
});

describe("rating a cell", () => {
	it("rates the text as it stands; an edit makes the rating stale", () => {
		const j = notebook({ role: "reflection", source: "Recursion = a function calling itself." });
		const cellId = j.cells[0]!.id;
		const { journal, prereqCellId } = learning.rateCell(j.id, cellId, 47);
		assert.equal(prereqCellId, undefined);
		assert.equal(journal.cells[0]!.understanding?.confidence, 50, "snapped to the nearest stop");
		assert.equal(journal.cells[0]!.understanding?.level, "helped");
		assert.equal(core.ratingIsStale(journal.cells[0]!), false);
		const edited = patchJournalCell(j.id, cellId, { source: "Recursion = a function defined in terms of itself." });
		assert.equal(core.ratingIsStale(edited.cells[0]!), true);
		assert.equal(learning.rateCell(j.id, cellId, null).journal.cells[0]!.understanding, undefined);
	});
	it("0% ('stuck') puts ONE prerequisites agent cell right above, reused on re-rating", () => {
		const j = notebook({ role: "reflection", source: "Intro." }, { role: "reflection", source: "The Y combinator gives recursion without names." });
		const stuckId = j.cells[1]!.id;
		const first = learning.rateCell(j.id, stuckId, 0);
		const cells = first.journal.cells;
		assert.equal(cells.length, 3);
		assert.equal(cells[1]!.id, first.prereqCellId);
		assert.equal(cells[1]!.role, "agent");
		assert.match(cells[1]!.source, /^\*\*Prerequisites\*\* for cell 3 \(the cell right below\)/);
		assert.equal(cells[2]!.id, stuckId);
		const again = learning.rateCell(j.id, stuckId, 0);
		assert.equal(again.prereqCellId, first.prereqCellId);
		assert.equal(again.journal.cells.length, 3);
	});
	it("'stuck' on the first cell inserts at the very top", () => {
		const j = notebook({ role: "code", source: "fix = lambda f: f(f)" });
		const r = learning.rateCell(j.id, j.cells[0]!.id, 0);
		assert.equal(r.journal.cells[0]!.id, r.prereqCellId);
	});
	it("agent cells are not rated", () => {
		const j = notebook({ role: "agent", source: "explain" });
		assert.throws(() => learning.rateCell(j.id, j.cells[0]!.id, 90), /Only markdown and code/);
	});
	it("confidence: stops, levels, older level-only ratings, ←/→ stepping", () => {
		assert.equal(core.snapConfidence(64), 70);
		assert.equal(core.snapConfidence(12), 0);
		assert.deepEqual([0, 30, 50, 70, 90, 100].map(core.levelForConfidence), ["stuck", "helped", "helped", "own", "own", "own"]);
		assert.equal(core.cellConfidence({ level: "own" }), 90);
		assert.equal(core.cellConfidence({ level: "stuck" }), 0);
		assert.equal(core.cellConfidence({ level: "helped", confidence: 30 }), 30);
		assert.equal(core.stepConfidence(null, 1), 50);
		assert.equal(core.stepConfidence(50, -1), 30);
		assert.equal(core.stepConfidence(100, 1), 100);
		assert.equal(core.stepConfidence(0, -1), 0);
	});
});

describe("graph extraction per notebook", () => {
	it("reads the whole notebook only when asked; unchanged text is a no-op; an edit re-reads it", async () => {
		const j = notebook(
			{ role: "reflection", source: "A base case ends the recursion." },
			{ role: "code", source: "def f(n): return 1 if n == 0 else n * f(n - 1)" },
			{ role: "aside", source: "Each call gets its own frame." },
		);
		const r1 = await learning.extractNotebook(j.id);
		assert.equal(r1.outcome, "extracted");
		assert.deepEqual(calls, [{ filePath: core.notebookSourcePath(j.id), text: "# Recursion\n\nA base case ends the recursion.\n\nEach call gets its own frame." }]);
		assert.equal(core.notebookGraphStatus(r1.journal), "current");
		assert.equal(r1.journal.graph?.nodes, 2);

		assert.equal((await learning.extractNotebook(j.id)).outcome, "unchanged");
		assert.equal(calls.length, 1);

		const edited = patchJournalCell(j.id, j.cells[0]!.id, { source: "A base case ends the recursion; without one it never stops." });
		assert.equal(core.notebookGraphStatus(edited), "stale");
		assert.equal((await learning.extractNotebook(j.id)).outcome, "extracted");
		assert.equal(calls.length, 2);
		assert.match(calls[1]!.text, /never stops/);
	});
	it("a notebook emptied of learner writing withdraws its contribution", async () => {
		const j = notebook({ role: "reflection", source: "Tail calls can reuse the frame." });
		await learning.extractNotebook(j.id);
		patchJournalCell(j.id, j.cells[0]!.id, { source: "" });
		const r = await learning.extractNotebook(j.id);
		assert.equal(r.outcome, "withdrawn");
		assert.equal(r.journal.graph, undefined);
	});
	it("nothing to read → nothing; agent and code cells are never read", async () => {
		const j = notebook({ role: "agent", source: "explain recursion" }, { role: "code", source: "x = 1" });
		assert.equal((await learning.extractNotebook(j.id)).outcome, "nothing");
		assert.equal(calls.length, 0);
	});
	it("each notebook is one graph source; source paths parse back to the notebook", () => {
		assert.notEqual(learning.notebookSourceId("jrnl_a"), learning.notebookSourceId("jrnl_b"));
		assert.match(learning.notebookSourceId("jrnl_a"), /^src_[0-9a-f]{12}$/);
		assert.deepEqual(core.parseNotebookSourcePath("notebook://jrnl_a"), { journalId: "jrnl_a" });
		assert.deepEqual(core.parseNotebookSourcePath("notebook://jrnl_a/cell_1"), { journalId: "jrnl_a", cellId: "cell_1" });
		assert.equal(core.parseNotebookSourcePath("notes/today.md"), null);
	});
	it("re-reading a notebook drops legacy per-cell graph state", async () => {
		const j = notebook({ role: "reflection", source: "Old per-cell idea." });
		setCellLearning(j.id, j.cells[0]!.id, { graph: { hash: "x", at: "2026-11-15T00:00:00.000Z", nodes: 1, chains: 0 } });
		const r = await learning.extractNotebook(j.id);
		assert.equal(r.outcome, "extracted");
		assert.equal(r.journal.cells[0]!.graph, undefined);
		assert.ok(r.journal.graph);
	});
	it("publish reads the notebook when new or changed, then is a no-op", async () => {
		const j = notebook({ role: "reflection", source: "Published idea." }, { role: "code", source: "x = 1" });
		assert.equal(learning.extractPublishedNotebook(requireJournal(j.id)), "started");
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual(calls.map((c) => c.text), ["# Recursion\n\nPublished idea."]);
		assert.equal(learning.extractPublishedNotebook(requireJournal(j.id)), "unchanged");
	});
	it("deleting a cell leaves the notebook stale; deleting the notebook works", async () => {
		const j = notebook({ role: "reflection", source: "Memoization caches subcalls." }, { role: "reflection", source: "Keep me." });
		await learning.extractNotebook(j.id);
		const after = learning.deleteNotebookCell(j.id, j.cells[0]!.id);
		assert.deepEqual(after.cells.map((c) => c.source), ["Keep me."]);
		assert.equal(core.notebookGraphStatus(after), "stale");
		assert.equal(learning.deleteNotebook(j.id), true);
	});
});
