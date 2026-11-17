/**
 * Journal notebook additions (owner, 2026-11-15): the notebook key map,
 * agent cells, search-everything, and image / video embeds (store, export,
 * publish bundle). Pure seams + the media store on a temp data dir.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-journal-notebook-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { KEYBOARD_ACTIONS, actionForBinding, bindingForAction, eventMatchesAction } = await import("../src/core/keyboard.ts");
const { newJournal, appendCell, removeCell, restoreCell } = await import("../src/core/journal.ts");
const { parseRestoreCell } = await import("../src/server/journals.ts");
const { exportJournal, publishedMediaNames } = await import("../src/core/journal-export.ts");
const { journalAgentPrompt } = await import("../src/core/journal-code.ts");
const { searchJournals } = await import("../src/core/journal-search.ts");
const media = await import("../src/core/journal-media.ts");
const { notebookStore: journalStore } = await import("../src/store/notebooks.ts");
const { saveJournalMedia, journalMediaFile } = await import("../src/server/journal-media.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const NOW = "2026-11-15T10:00:00.000Z";
const key = (init: Partial<KeyboardEvent> & { key: string }) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: "", ...init }) as KeyboardEvent;

describe("notebook key map", () => {
	it("Mod+B / Mod+M / Mod+L add code / markdown / agent cells", () => {
		assert.equal(bindingForAction("journal-new-code"), "mod+b");
		assert.equal(bindingForAction("journal-new-markdown"), "mod+m");
		assert.equal(bindingForAction("journal-new-agent"), "mod+l");
		assert.ok(eventMatchesAction(key({ key: "b", ctrlKey: true }), "journal-new-code"));
		assert.ok(eventMatchesAction(key({ key: "l", metaKey: true }), "journal-new-agent"));
	});
	it("Esc / Tab / Enter / arrows drive command mode", () => {
		assert.ok(eventMatchesAction(key({ key: "Escape" }), "journal-exit-cell"));
		assert.ok(eventMatchesAction(key({ key: "Tab" }), "journal-focus-top"));
		assert.ok(eventMatchesAction(key({ key: "Enter" }), "journal-edit-cell"));
		assert.ok(eventMatchesAction(key({ key: "ArrowDown" }), "journal-next-cell"));
		assert.ok(eventMatchesAction(key({ key: "Enter", ctrlKey: true }), "journal-run-cell"));
		assert.ok(eventMatchesAction(key({ key: "Enter", shiftKey: true }), "journal-run-next"));
	});
	it("journal keys are surface-owned: never in the global dispatch map", () => {
		for (const a of KEYBOARD_ACTIONS.filter((a) => a.scope === "journal")) assert.equal(a.surfaceOwned, true, a.id);
		assert.equal(actionForBinding("mod+b"), undefined);
		assert.equal(actionForBinding("mod+l"), undefined);
	});
	it("Mod+K is search-everything; the model picker moved to Mod+Shift+K", () => {
		assert.equal(actionForBinding("mod+k"), "search-everything");
		assert.equal(actionForBinding("mod+shift+k"), "open-model-picker");
	});
	it("Esc then D deletes; Mod+Z / Mod+Shift+Z step the notebook's history", () => {
		assert.ok(eventMatchesAction(key({ key: "d" }), "journal-delete-cell"));
		assert.ok(eventMatchesAction(key({ key: "z", ctrlKey: true }), "journal-undo"));
		assert.ok(eventMatchesAction(key({ key: "Z", ctrlKey: true, shiftKey: true }), "journal-redo"));
		assert.ok(!eventMatchesAction(key({ key: "Z", ctrlKey: true, shiftKey: true }), "journal-undo"));
		// Surface-owned: never in the global map, where Mod+Z would steal every text box's undo.
		assert.equal(actionForBinding("mod+z"), undefined);
	});
});

describe("restoreCell (notebook undo of a delete)", () => {
	const three = () => {
		let j = newJournal({ id: "jrnl_u", title: "Undo", now: NOW });
		for (const id of ["a", "b", "c"]) j = appendCell(j, { id, role: "reflection", source: id }, NOW);
		return j;
	};
	it("puts the whole cell back at its index with its id, rating and output — but not its graph state", () => {
		const j = three();
		const b = { ...j.cells[1]!, output: "out", understanding: { level: "own" as const, hash: "h", at: NOW }, graph: { hash: "h", at: NOW, nodes: 2 } as never };
		const back = restoreCell(removeCell(j, "b", NOW), b, 1, "2026-11-16T00:00:00.000Z");
		assert.deepEqual(back.cells.map((c) => c.id), ["a", "b", "c"]);
		assert.equal(back.cells[1]!.output, "out");
		assert.equal(back.cells[1]!.understanding?.level, "own");
		assert.equal("graph" in back.cells[1]!, false);
		assert.equal(back.cells[1]!.updatedAt, "2026-11-16T00:00:00.000Z");
	});
	it("clamps the index and refuses a duplicate id", () => {
		const j = three();
		const a = j.cells[0]!;
		assert.deepEqual(restoreCell(removeCell(j, "a", NOW), a, 99, NOW).cells.map((c) => c.id), ["b", "c", "a"]);
		assert.throws(() => restoreCell(j, a, 0, NOW), /already exists/);
	});
	it("parseRestoreCell validates untrusted bodies", () => {
		assert.equal(parseRestoreCell({ role: "code" }), null);
		const { cell, index } = parseRestoreCell({ index: 2, restore: { id: "cell_x", role: "code", source: "1", lang: "python", publish: true, executionCount: 3, junk: 1 } })!;
		assert.equal(index, 2);
		assert.deepEqual([cell.id, cell.role, cell.lang, cell.executionCount, "junk" in cell], ["cell_x", "code", "python", 3, false]);
		assert.throws(() => parseRestoreCell({ index: 0, restore: { id: "../x", role: "code" } }), /malformed/);
		assert.throws(() => parseRestoreCell({ index: 0, restore: { id: "cell_x", role: "nope" } }), /Unknown cell role/);
		assert.throws(() => parseRestoreCell({ restore: { id: "cell_x", role: "code" } }), /index/);
	});
});

function journal(id: string, title: string, cells: Array<{ id: string; role: "code" | "reflection" | "agent"; source: string; output?: string; lang?: string; publish?: boolean }>) {
	let j = newJournal({ id, title, now: NOW });
	for (const c of cells) j = appendCell(j, c, NOW);
	return j;
}

describe("agent cells", () => {
	const j = journal("jrnl_a", "Sorting", [
		{ id: "c1", role: "code", lang: "python", source: "sorted([3, 1])", output: "[1, 3]" },
		{ id: "a1", role: "agent", source: "Explain the cell above.", output: "It sorts." },
	]);
	it("the prompt carries the notebook above and the request", () => {
		const p = journalAgentPrompt(j, "a1");
		assert.match(p, /Cells above the agent cell:[\s\S]*sorted\(\[3, 1\]\)[\s\S]*\[1, 3\]/);
		assert.match(p, /Request \(agent cell 2\):\n"""\nExplain the cell above\.\n"""$/);
	});
	it("is private by default; published, it exports request + answer", () => {
		assert.equal(j.cells[1]!.publish, false);
		const pub = { ...j, cells: j.cells.map((c) => ({ ...c, publish: true })) };
		const md = exportJournal(pub, { date: "2026-11-15", format: "markdown" }).files["index.md"]!;
		assert.match(md, /<div class="agent" markdown="1">\n\n\*\*Asked\*\*\n\nExplain the cell above\.\n\nIt sorts\.\n\n<\/div>/);
		const nb = JSON.parse(exportJournal(pub, { date: "2026-11-15", format: "notebook" }).files["notebook.ipynb"]!);
		assert.equal(nb.cells[1].source.join(""), "**Asked**\n\n> Explain the cell above.\n\nIt sorts.");
	});
});

describe("searchJournals", () => {
	const js = [
		journal("j1", "Graph search", [{ id: "x", role: "reflection", source: "BFS visits by layers." }]),
		journal("j2", "Sorting", [
			{ id: "y", role: "code", lang: "python", source: "sorted(nums)", output: "[1, 2, 3]" },
			{ id: "z", role: "reflection", source: "Quick sort partitions around a pivot." },
		]),
	];
	it("matches titles first, then cell text and outputs; every term must hit", () => {
		assert.deepEqual(searchJournals(js, "sort").map((h) => h.cellId ?? `title:${h.journalId}`), ["title:j2", "y", "z"]);
		assert.deepEqual(searchJournals(js, "[1, 2").map((h) => h.cellId), ["y"]);
		assert.deepEqual(searchJournals(js, "bfs layers").map((h) => h.cellId), ["x"]);
		assert.deepEqual(searchJournals(js, "bfs pivot"), []);
		assert.deepEqual(searchJournals(js, "   "), []);
	});
});

describe("media embeds", () => {
	it("names, refs and the published form", () => {
		assert.equal(media.mediaFileName("My Plot (final).PNG", "ab12cd"), "my-plot-final-ab12cd.png");
		assert.equal(media.isSafeMediaName("../etc/passwd.png"), false);
		assert.equal(media.isSafeMediaName("x-1.exe"), false);
		assert.equal(media.mediaMarkdown("p-1.png", "a [plot]"), "![a plot](media/p-1.png)");
		assert.deepEqual(media.mediaRefs("![a](media/p-1.png) and ![b](https://x/y.png) ![c](media/v-2.mp4)"), ["p-1.png", "v-2.mp4"]);
		assert.deepEqual(media.mediaEmbedLine("  ![clip](media/v-2.mp4) "), { alt: "clip", name: "v-2.mp4", kind: "video" });
		assert.equal(media.mediaEmbedLine("see ![a](media/p-1.png) inline"), null);
		assert.equal(
			media.publishedMediaMarkdown('Look:\n![a "clip"](media/v-2.mp4)\n![p](media/p-1.png)'),
			'Look:\n<video controls preload="metadata" src="media/v-2.mp4" aria-label="a &quot;clip&quot;"></video>\n![p](media/p-1.png)',
		);
	});
	it("export lists only media of published, non-code cells", () => {
		const j = journal("jrnl_m", "Media", [
			{ id: "r", role: "reflection", source: "![p](media/p-1.png)\n![v](media/v-2.mp4)" },
			{ id: "hidden", role: "reflection", source: "![q](media/q-3.png)", publish: false },
			{ id: "c", role: "code", source: "# ![x](media/x-4.png)" },
		]);
		assert.deepEqual(publishedMediaNames(j), ["p-1.png", "v-2.mp4"]);
	});
	it("the store streams uploads to disk and refuses non-media", async () => {
		journalStore.createJournal(newJournal({ id: "jrnl_store", title: "Store", now: NOW }));
		const body = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])]).stream();
		const saved = await saveJournalMedia("jrnl_store", "Shot 1.png", body);
		assert.match(saved.name, /^shot-1-[0-9a-f]{6}\.png$/);
		assert.equal(saved.bytes, 7);
		assert.equal(saved.markdown, `![Shot 1](media/${saved.name})`);
		assert.equal(fs.readFileSync(journalMediaFile("jrnl_store", saved.name)!).length, 7);
		assert.equal(journalMediaFile("jrnl_store", "../../settings.json"), null);
		await assert.rejects(saveJournalMedia("jrnl_store", "notes.txt", new Blob(["x"]).stream()), /Only images/);
		await assert.rejects(saveJournalMedia("jrnl_nope", "a.png", new Blob(["x"]).stream()), /No journal/);
	});
});

describe("inline ask (Mod+L while editing)", async () => {
	const { inlineAskPrompt, unfenceInsert } = await import("../src/core/journal-code.ts");
	const { parseInlineAsk } = await import("../src/server/journals.ts");
	const j = journal("jrnl_i", "Search", [
		{ id: "m", role: "reflection", source: "Saved text." },
		{ id: "c", role: "code", lang: "python", source: "print(1)", output: "1" },
	]);
	it("sends the live draft, the highlight and the task", () => {
		const p = inlineAskPrompt(j, "m", { mode: "explain", draft: "Binary search is O(log n).", role: "reflection", selection: "O(log n)", turns: [] });
		assert.match(p, /\[THE CELL BEING EDITED\] markdown\n"""\nBinary search is O\(log n\)\.\n"""/);
		assert.match(p, /Cells below:[\s\S]*print\(1\)/);
		assert.match(p, /Highlighted passage:\n"""\nO\(log n\)\n"""/);
		assert.match(p, /Explain the highlighted passage\.$/);
		assert.doesNotMatch(p, /Saved text\./, "the draft replaces the saved text");
	});
	it("follow-ups carry the earlier popup turns", () => {
		const p = inlineAskPrompt(j, "m", {
			mode: "ask",
			draft: "x",
			role: "reflection",
			selection: "x",
			turns: [
				{ role: "assistant", text: "First answer." },
				{ role: "user", text: "why?" },
			],
		});
		assert.match(p, /Earlier in this popup:\n\nYou: First answer\./);
		assert.match(p, /Question about the highlighted passage: why\?$/);
	});
	it("insert answers lose a stray fence in code cells only", () => {
		assert.equal(unfenceInsert("```python\nx = 1\n```", "code"), "x = 1");
		assert.equal(unfenceInsert("```python\nx = 1\n```", "reflection"), "```python\nx = 1\n```");
	});
	it("the route body is validated", () => {
		assert.throws(() => parseInlineAsk({ mode: "shout", role: "code" }), /mode/);
		assert.throws(() => parseInlineAsk({ mode: "ask", role: "poem" }), /role/);
		const ok = parseInlineAsk({ mode: "insert", role: "code", lang: "cpp", draft: "d", selection: "s", turns: [{ role: "user", text: "q" }, { role: "x", text: 1 }] });
		assert.deepEqual(ok, { mode: "insert", draft: "d", role: "code", lang: "cpp", selection: "s", turns: [{ role: "user", text: "q" }] });
	});
});
