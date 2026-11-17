/**
 * Notebooks launched from the graph (owner, 2026-11-15): Teach seeds an
 * agent cell to run; Practice writes one exercise per picked idea (or an
 * agent-cell fallback). Picked ideas never land in graph-read cells.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notebook-launch-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const core = await import("../src/core/notebook-from-graph.ts");
const { notebookExtractableText } = await import("../src/core/notebook-learning.ts");
const launch = await import("../src/server/notebook-from-graph.ts");

after(() => {
	launch.setExerciseWriterForTests(null);
	fs.rmSync(TMP, { recursive: true, force: true });
});

const picks = [
	{ id: "n1", name: "Base case", statement: "A recursion stops at a case it answers directly." },
	{ id: "n2", name: "Call stack", statement: "Each call keeps its own frame until it returns." },
];

describe("pure builders", () => {
	it("parses a launch body; rejects a bad mode or empty topic; drops malformed picks", () => {
		const input = core.parseNotebookLaunch({ mode: "practice", topic: "  recursion ", propositions: [...picks, { id: 1 }] });
		assert.deepEqual(input, { mode: "practice", topic: "recursion", picks });
		assert.equal(core.parseNotebookLaunch({ topic: "x" }).mode, "teach");
		assert.throws(() => core.parseNotebookLaunch({ mode: "improvise", topic: "x" }), /Unknown mode/);
		assert.throws(() => core.parseNotebookLaunch({ mode: "teach", topic: " " }), /topic is required/);
	});
	it("teach: an agent cell carrying the picks, then an empty cell for the learner", () => {
		const cells = core.teachCells("recursion", picks);
		assert.equal(cells[0]!.role, "agent");
		assert.equal(cells[0]!.run, true);
		assert.match(cells[0]!.source, /^\*\*Teach me\*\*: recursion/);
		assert.match(cells[0]!.source, /\*\*Base case\*\*: A recursion stops/);
		assert.deepEqual(cells[1], { role: "reflection", source: "" });
	});
	it("practice: exercise + empty attempt per exercise; null falls back to an agent cell", () => {
		assert.deepEqual(core.practiceCells("r", picks, ["Q1", "Q2"]).map((c) => c.role), ["exercise", "attempt", "exercise", "attempt"]);
		const fallback = core.practiceCells("r", picks, null);
		assert.equal(fallback[0]!.role, "agent");
		assert.equal(fallback[0]!.run, true);
		assert.match(fallback[0]!.source, /one problem per idea/);
	});
	it("parses the exercise JSON robustly", () => {
		assert.deepEqual(core.parsePracticeExercises('Sure!\n[{"idea":"n1","exercise":"What does f(0) return?"},{"idea":"n2","exercise":" Trace f(2). "}]'), ["What does f(0) return?", "Trace f(2)."]);
		assert.equal(core.parsePracticeExercises("no json here"), null);
		assert.equal(core.parsePracticeExercises('[{"idea":"n1"}]'), null);
		assert.equal(core.parsePracticeExercises("[not json]"), null);
	});
	it("title is trimmed and capped; tags are the picked names", () => {
		assert.equal(core.launchTitle("  how   does recursion work? "), "how does recursion work?");
		assert.equal(core.launchTitle("x".repeat(200)).length, 80);
		assert.deepEqual(core.launchTags([...picks, picks[0]!]), ["Base case", "Call stack"]);
	});
});

describe("launching", () => {
	it("teach creates the notebook and names the agent cell to run; nothing graph-readable yet", async () => {
		const { journal, runCellId } = await launch.launchNotebookFromGraph({ mode: "teach", topic: "Recursion", picks });
		assert.equal(journal.title, "Recursion");
		assert.deepEqual(journal.tags, ["Base case", "Call stack"]);
		assert.equal(journal.cells.find((c) => c.id === runCellId)?.role, "agent");
		assert.equal(notebookExtractableText(journal), null);
	});
	it("practice writes the exercises up front", async () => {
		launch.setExerciseWriterForTests(async () => '[{"idea":"n1","exercise":"What is f(0)?"},{"idea":"n2","exercise":"Trace f(2)."}]');
		const { journal, runCellId } = await launch.launchNotebookFromGraph({ mode: "practice", topic: "Recursion", picks });
		assert.equal(runCellId, undefined);
		assert.deepEqual(journal.cells.map((c) => [c.role, c.source]), [
			["exercise", "What is f(0)?"],
			["attempt", ""],
			["exercise", "Trace f(2)."],
			["attempt", ""],
		]);
	});
	it("practice falls back to an agent cell when the model reply is unusable", async () => {
		launch.setExerciseWriterForTests(async () => "I can't do JSON today.");
		const { journal, runCellId } = await launch.launchNotebookFromGraph({ mode: "practice", topic: "Recursion", picks: [] });
		assert.equal(journal.cells.find((c) => c.id === runCellId)?.role, "agent");
		assert.match(journal.cells[0]!.source, /three problems/);
	});
});
