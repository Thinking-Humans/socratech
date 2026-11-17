/**
 * Owner, 2026-11-17: the scratchpad (Mod+P), the notebook switcher (Mod+O)
 * with pinned slots (Alt+1 … Alt+9) — key map, slot / recent bookkeeping,
 * list ordering, and the scratchpad's one file in the data dir.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notebook-switch-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { actionForBinding, eventBinding } = await import("../src/core/keyboard.ts");
const { NOTEBOOK_SLOT_COUNT, assignSlot, normalizeRecent, normalizeSlots, orderNotebooks, touchRecent } = await import("../src/core/notebook-switch.ts");
const { eventMatchesAction } = await import("../src/core/keyboard.ts");
const { newJournal, appendCell } = await import("../src/core/journal.ts");
const { flashcardDraftPrompt, flashcardSourceText, parseFlashcardDrafts, FLASHCARD_DRAFT_LIMIT } = await import("../src/core/journal-code.ts");
const { readScratchpad, writeScratchpad, SCRATCHPAD_MAX_CHARS } = await import("../src/server/scratchpad.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const key = (init: Partial<KeyboardEvent> & { key: string }) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: "", ...init }) as KeyboardEvent;
const books = [
	{ id: "a", title: "Linear algebra" },
	{ id: "b", title: "Lambda calculus" },
	{ id: "c", title: "Graph theory" },
	{ id: "d", title: "Algebraic topology" },
];
const ids = (r: { rows: { item: { id: string } }[] }) => r.rows.map((row) => row.item.id);

describe("scratchpad + switcher key map", () => {
	it("Mod+P toggles the scratchpad, Mod+O opens the switcher, Alt+1…9 jump to slots", () => {
		assert.equal(actionForBinding(eventBinding(key({ key: "p", ctrlKey: true }))), "toggle-scratchpad");
		assert.equal(actionForBinding(eventBinding(key({ key: "o", metaKey: true }))), "switch-notebook");
		for (let n = 1; n <= 9; n++) assert.equal(actionForBinding(eventBinding(key({ key: String(n), altKey: true }))), `notebook-slot-${n}`);
		assert.equal(actionForBinding("alt+0"), undefined);
	});
});

describe("pinned slots", () => {
	it("normalizes untrusted storage to nine slots, each notebook once", () => {
		assert.deepEqual(normalizeSlots("junk"), Array(NOTEBOOK_SLOT_COUNT).fill(null));
		assert.deepEqual(normalizeSlots(["a", 3, "a", "b"]).slice(0, 4), ["a", null, null, "b"]);
		assert.equal(normalizeSlots(Array(20).fill("x")).length, NOTEBOOK_SLOT_COUNT);
	});
	it("pins, replaces, swaps and unpins", () => {
		let slots = assignSlot(normalizeSlots(null), 0, "a");
		slots = assignSlot(slots, 1, "b");
		assert.deepEqual(slots.slice(0, 3), ["a", "b", null]);
		// Its own slot again: unpinned.
		assert.deepEqual(assignSlot(slots, 0, "a").slice(0, 2), [null, "b"]);
		// From another slot: the two swap.
		assert.deepEqual(assignSlot(slots, 1, "a").slice(0, 2), ["b", "a"]);
		// A new notebook replaces the occupant.
		assert.deepEqual(assignSlot(slots, 0, "c").slice(0, 2), ["c", "b"]);
		// Moving to a free slot frees the old one.
		assert.deepEqual(assignSlot(slots, 2, "a").slice(0, 3), [null, "b", "a"]);
		assert.deepEqual(assignSlot(slots, 99, "c"), slots);
	});
});

describe("recently opened", () => {
	it("moves the opened notebook to the front, once", () => {
		assert.deepEqual(touchRecent(["a", "b", "c"], "c"), ["c", "a", "b"]);
		assert.deepEqual(touchRecent([], "a"), ["a"]);
		assert.deepEqual(normalizeRecent(["a", 1, "a", "", "b"]), ["a", "b"]);
		assert.deepEqual(normalizeRecent(null), []);
	});
});

describe("switcher order", () => {
	it("pinned by slot, then recently opened, then the rest; the previous notebook is preselected", () => {
		const slots = assignSlot(assignSlot(normalizeSlots(null), 1, "d"), 0, "c");
		const r = orderNotebooks(books, { slots, recent: ["a", "b"], currentId: "a" });
		assert.deepEqual(ids(r), ["c", "d", "a", "b"]);
		assert.deepEqual(r.rows.map((row) => row.slot), [1, 2, undefined, undefined]);
		assert.equal(r.rows[2]!.current, true);
		assert.equal(r.rows[r.selected]!.item.id, "b", "Enter flips to the notebook before this one");
	});
	it("preselects a pinned previous notebook where it sits; ignores deleted recents", () => {
		const r = orderNotebooks(books, { slots: assignSlot(normalizeSlots(null), 0, "d"), recent: ["a", "gone", "d", "b"], currentId: "a" });
		assert.deepEqual(ids(r), ["d", "a", "b", "c"]);
		assert.equal(r.rows[r.selected]!.item.id, "d");
	});
	it("with no history, preselects the first notebook that is not open", () => {
		const r = orderNotebooks(books, { slots: normalizeSlots(null), recent: [], currentId: "a" });
		assert.equal(r.rows[r.selected]!.item.id, "b");
		assert.equal(orderNotebooks([], { slots: normalizeSlots(null), recent: [] }).selected, 0);
	});
	it("a query fuzzy-filters titles, best match first", () => {
		const r = orderNotebooks(books, { slots: assignSlot(normalizeSlots(null), 0, "d"), recent: ["a"], currentId: "a", query: "alg" });
		assert.deepEqual(ids(r), ["d", "a"], "a title starting with the query beats one containing it");
		assert.equal(r.selected, 0);
		assert.equal(r.rows[0]!.slot, 1);
		assert.deepEqual(ids(orderNotebooks(books, { slots: normalizeSlots(null), recent: [], query: "zzz" })), []);
	});
});

describe("scratchpad store", () => {
	it("is empty before the first write, then keeps the last text across reads", () => {
		assert.equal(readScratchpad(), "");
		writeScratchpad({ text: "todo: reread ch. 3\n\tλx.x" });
		assert.equal(readScratchpad(), "todo: reread ch. 3\n\tλx.x");
		assert.equal(fs.readFileSync(path.join(TMP, "data", "scratchpad.md"), "utf-8"), "todo: reread ch. 3\n\tλx.x");
		writeScratchpad({ text: "" });
		assert.equal(readScratchpad(), "");
	});
	it("refuses a non-string or oversized body and keeps what was there", () => {
		writeScratchpad({ text: "keep" });
		assert.throws(() => writeScratchpad({ text: 5 }), /text \(string\) is required/);
		assert.throws(() => writeScratchpad({ text: "x".repeat(SCRATCHPAD_MAX_CHARS + 1) }), /too long/);
		assert.equal(readScratchpad(), "keep");
	});
});

describe("cell flashcards", () => {
	const NOW = "2026-11-17T10:00:00.000Z";
	let j = newJournal({ id: "jrnl_f", title: "Recursion", now: NOW });
	j = appendCell(j, { id: "a", role: "reflection", source: "Intro to recursion." }, NOW);
	j = appendCell(j, { id: "b", role: "reflection", source: "A base case ends the recursion." }, NOW);
	j = appendCell(j, { id: "c", role: "agent", source: "Why does it need one?", output: "Without it the calls never stop." }, NOW);
	j = appendCell(j, { id: "d", role: "reflection", source: "  " }, NOW);

	it("F is the notebook's flashcards key, surface-owned", () => {
		assert.ok(eventMatchesAction(key({ key: "f" }), "journal-flashcards"));
		assert.equal(actionForBinding("f"), undefined);
	});
	it("drafts from the cell's text (an agent cell: request + answer); an empty cell has none", () => {
		assert.equal(flashcardSourceText(j.cells[1]!), "A base case ends the recursion.");
		assert.equal(flashcardSourceText(j.cells[2]!), "Why does it need one?\n\nWithout it the calls never stop.");
		assert.equal(flashcardSourceText(j.cells[3]!), null);
	});
	it("the prompt marks the focus cell and carries the others as context", () => {
		const prompt = flashcardDraftPrompt(j, "b");
		assert.match(prompt, /\[FOCUS CELL\] reflection\n"""\nA base case ends the recursion\./);
		assert.match(prompt, /Cells before the focus cell \(context only\):[\s\S]*Intro to recursion\./);
		assert.match(flashcardDraftPrompt(j, "c"), /Agent answer:\n"""\nWithout it the calls never stop\./);
		assert.throws(() => flashcardDraftPrompt(j, "nope"), /No cell/);
	});
	it("parses the reply: bare array, fenced, or wrapped in prose", () => {
		const cards = '[{"name": "Base case", "question": "What ends a recursion?", "answer": "A base case."}]';
		const want = [{ name: "Base case", question: "What ends a recursion?", answer: "A base case." }];
		assert.deepEqual(parseFlashcardDrafts(cards), want);
		assert.deepEqual(parseFlashcardDrafts("```json\n" + cards + "\n```"), want);
		assert.deepEqual(parseFlashcardDrafts(`Here you go:\n${cards}\nEnjoy.`), want);
	});
	it("drops incomplete cards, names a nameless one from its question, caps the count", () => {
		const reply = JSON.stringify([{ question: " Q1? ", answer: " A1 " }, { name: "x", question: "", answer: "A" }, "junk", { name: "n", question: "Q", answer: 3 }]);
		assert.deepEqual(parseFlashcardDrafts(reply), [{ name: "Q1?", question: "Q1?", answer: "A1" }]);
		const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, question: `q${i}`, answer: `a${i}` })));
		assert.equal(parseFlashcardDrafts(many).length, FLASHCARD_DRAFT_LIMIT);
	});
	it("refuses a reply with no usable card", () => {
		for (const reply of ["", "no json here", "[]", "[{]", '{"name":"x"}', "*(failed: rate limit)*"]) assert.throws(() => parseFlashcardDrafts(reply), /did not return any flashcards/, reply);
	});
});

describe("product version vs plugin compatibility (Socratech 0.2)", () => {
	it("every bundled plugin is admitted at package.json's pluginHostVersion, whatever the product version", async () => {
		const { parsePluginManifest } = await import("../src/core/plugins.ts");
		const root = path.resolve(import.meta.dirname, "..");
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as { version: string; pluginHostVersion: string };
		assert.match(pkg.pluginHostVersion, /^\d+\.\d+\.\d+$/);
		const core = JSON.parse(fs.readFileSync(path.join(root, "core-plugins.json"), "utf-8")) as string[];
		for (const id of core) {
			const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugins", id, "manifest.json"), "utf-8"));
			assert.doesNotThrow(() => parsePluginManifest(manifest, id, pkg.pluginHostVersion), id);
		}
	});
});
