/**
 * Notebooks as the unit of learning (owner, 2026-11-15): ratings, the
 * prerequisites cell for "stuck", the cross-check verdict parser, and
 * per-cell graph extraction (on request / publish; edits replace).
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
const { createJournal, addJournalCell, patchJournalCell, requireJournal } = await import("../src/server/journals.ts");
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
		const { journal, prereqCellId } = learning.rateCell(j.id, cellId, "helped");
		assert.equal(prereqCellId, undefined);
		assert.equal(journal.cells[0]!.understanding?.level, "helped");
		assert.equal(core.ratingIsStale(journal.cells[0]!), false);
		const edited = patchJournalCell(j.id, cellId, { source: "Recursion = a function defined in terms of itself." });
		assert.equal(core.ratingIsStale(edited.cells[0]!), true);
		assert.equal(learning.rateCell(j.id, cellId, null).journal.cells[0]!.understanding, undefined);
	});
	it("'stuck' puts ONE prerequisites agent cell right above, reused on re-rating", () => {
		const j = notebook({ role: "reflection", source: "Intro." }, { role: "reflection", source: "The Y combinator gives recursion without names." });
		const stuckId = j.cells[1]!.id;
		const first = learning.rateCell(j.id, stuckId, "stuck");
		const cells = first.journal.cells;
		assert.equal(cells.length, 3);
		assert.equal(cells[1]!.id, first.prereqCellId);
		assert.equal(cells[1]!.role, "agent");
		assert.match(cells[1]!.source, /^\*\*Prerequisites\*\* for cell 3 \(the cell right below\)/);
		assert.equal(cells[2]!.id, stuckId);
		const again = learning.rateCell(j.id, stuckId, "stuck");
		assert.equal(again.prereqCellId, first.prereqCellId);
		assert.equal(again.journal.cells.length, 3);
	});
	it("'stuck' on the first cell inserts at the very top", () => {
		const j = notebook({ role: "code", source: "fix = lambda f: f(f)" });
		const r = learning.rateCell(j.id, j.cells[0]!.id, "stuck");
		assert.equal(r.journal.cells[0]!.id, r.prereqCellId);
	});
	it("agent cells are not rated", () => {
		const j = notebook({ role: "agent", source: "explain" });
		assert.throws(() => learning.rateCell(j.id, j.cells[0]!.id, "own"), /Only markdown and code/);
	});
});

describe("graph extraction per cell", () => {
	it("reads a cell only when asked; unchanged text is a no-op; an edit re-reads it", async () => {
		const j = notebook({ role: "reflection", source: "A base case ends the recursion." });
		const cellId = j.cells[0]!.id;
		const r1 = await learning.extractCell(j.id, cellId);
		assert.equal(r1.outcome, "extracted");
		assert.deepEqual(calls, [{ filePath: core.cellSourcePath(j.id, cellId), text: "# Recursion\n\nA base case ends the recursion." }]);
		assert.equal(core.cellGraphStatus(r1.journal.cells[0]!), "current");
		assert.equal(r1.journal.cells[0]!.graph?.nodes, 2);

		assert.equal((await learning.extractCell(j.id, cellId)).outcome, "unchanged");
		assert.equal(calls.length, 1);

		const edited = patchJournalCell(j.id, cellId, { source: "A base case ends the recursion; without one it never stops." });
		assert.equal(core.cellGraphStatus(edited.cells[0]!), "stale");
		assert.equal((await learning.extractCell(j.id, cellId)).outcome, "extracted");
		assert.equal(calls.length, 2);
		assert.match(calls[1]!.text, /never stops/);
	});
	it("a cell emptied of text withdraws its contribution", async () => {
		const j = notebook({ role: "reflection", source: "Tail calls can reuse the frame." });
		const cellId = j.cells[0]!.id;
		await learning.extractCell(j.id, cellId);
		patchJournalCell(j.id, cellId, { source: "" });
		const r = await learning.extractCell(j.id, cellId);
		assert.equal(r.outcome, "withdrawn");
		assert.equal(r.journal.cells[0]!.graph, undefined);
	});
	it("each cell is its own graph source", () => {
		assert.notEqual(learning.cellSourceId("jrnl_a", "cell_1"), learning.cellSourceId("jrnl_a", "cell_2"));
		assert.match(learning.cellSourceId("jrnl_a", "cell_1"), /^src_[0-9a-f]{12}$/);
	});
	it("publish extracts only published cells that are new or changed", async () => {
		const j = notebook({ role: "reflection", source: "Published idea." }, { role: "aside", source: "Private aside." }, { role: "code", source: "x = 1" });
		assert.equal(learning.extractPublishedCells(requireJournal(j.id)), "started");
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual(calls.map((c) => c.text), ["# Recursion\n\nPublished idea."]);
		assert.equal(learning.extractPublishedCells(requireJournal(j.id)), "unchanged");
	});
	it("deleting an extracted cell or notebook works and leaves no record", async () => {
		const j = notebook({ role: "reflection", source: "Memoization caches subcalls." }, { role: "reflection", source: "Keep me." });
		await learning.extractCell(j.id, j.cells[0]!.id);
		const after = learning.deleteNotebookCell(j.id, j.cells[0]!.id);
		assert.deepEqual(after.cells.map((c) => c.source), ["Keep me."]);
		assert.equal(learning.deleteNotebook(j.id), true);
	});
});
