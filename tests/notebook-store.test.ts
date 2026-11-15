/**
 * The marimo notebook store (src/store/notebooks.ts) on a temp data dir:
 * migration from data/journals/*.json (idempotent, backups kept), healing
 * hand edits made to the .py, and the marimo-clean check (python3 `ast`).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { spawnSync } from "node:child_process";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notebook-store-"));
const DATA = path.join(TMP, "data");
process.env.LH_DATA_DIR = DATA;

import type { Journal, JournalCell } from "../src/core/contracts/journal.ts";
const { notebookStore, migrateLegacyJournals, notebookPyFile, notebookSidecarFile } = await import("../src/store/notebooks.ts");
const { journalToMarimo } = await import("../src/core/marimo-format.ts");
const { marimoCleanCheck } = await import("../src/server/marimo-check.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const T = "2026-11-15T10:00:00.000Z";
const LEGACY = path.join(DATA, "journals");
const NOTEBOOKS = path.join(DATA, "notebooks");
const BACKUP = path.join(LEGACY, ".migrated");

function cell(id: string, role: JournalCell["role"], source: string, extra: Partial<JournalCell> = {}): JournalCell {
	return { id, role, source, publish: true, createdAt: T, updatedAt: T, ...extra };
}
function journal(id: string, cells: JournalCell[], extra: Partial<Journal> = {}): Journal {
	return { id, title: `Notebook ${id}`, slug: id.replace(/_/g, "-"), tags: [], cells, publications: [], createdAt: T, updatedAt: T, ...extra };
}

const legacyA = journal(
	"jrnl_legacy_a",
	[
		cell("c1", "exercise", 'Prove it. """ \\ {}', { origin: { chatId: "chat_1", toolCallId: "p1", ideaIds: ["n1"] } }),
		cell("c2", "code", "x = 1\nprint(x)", { lang: "python", output: "1\n", executionCount: 1 }),
		cell("c3", "agent", "Why?", { output: "Because.", publish: false }),
		cell("c4", "code", "int main(){}", { lang: "cpp" }),
	],
	{ chatId: "chat_1" },
);
const legacyB = journal("jrnl_legacy_b", [cell("cell_b00000000001", "reflection", "Plain note.")]);

// Legacy files exist before the store is first touched.
fs.mkdirSync(LEGACY, { recursive: true });
fs.writeFileSync(path.join(LEGACY, "jrnl_legacy_a.json"), JSON.stringify(legacyA, null, "\t"));
fs.writeFileSync(path.join(LEGACY, "jrnl_legacy_b.json"), JSON.stringify(legacyB, null, "\t"));
fs.writeFileSync(path.join(LEGACY, "jrnl_broken.json"), "{ not json");
fs.writeFileSync(path.join(LEGACY, "_opted-out.json"), JSON.stringify({ chat_gone: T }));

const hasPython = spawnSync("python3", ["-c", "pass"]).status === 0;

describe("migration from data/journals", () => {
	it("converts every journal on first use, keeps the JSON as a backup, leaves unreadable files", () => {
		assert.deepEqual(notebookStore.listJournals().map((s) => s.id).sort(), ["jrnl_legacy_a", "jrnl_legacy_b"]);
		assert.deepEqual(notebookStore.getJournal("jrnl_legacy_a"), legacyA);
		assert.deepEqual(notebookStore.getJournal("jrnl_legacy_b"), legacyB);
		assert.deepEqual(fs.readdirSync(NOTEBOOKS).sort(), [
			"_opted-out.json",
			"jrnl_legacy_a.py",
			"jrnl_legacy_a.socratech.json",
			"jrnl_legacy_b.py",
			"jrnl_legacy_b.socratech.json",
		]);
		assert.deepEqual(fs.readdirSync(LEGACY).sort(), [".migrated", "jrnl_broken.json"]);
		assert.deepEqual(fs.readdirSync(BACKUP).sort(), ["_opted-out.json", "jrnl_legacy_a.json", "jrnl_legacy_b.json"]);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(BACKUP, "jrnl_legacy_a.json"), "utf-8")), legacyA);
		assert.equal(notebookStore.isChatOptedOut("chat_gone"), true, "tombstones carried over");
		const py = fs.readFileSync(notebookPyFile("jrnl_legacy_a"), "utf-8");
		assert.match(py, /def c2\(\):\n {4}x = 1\n {4}print\(x\)\n {4}return \(x,\)/);
	});

	it("is idempotent: a second run moves nothing, and a notebook that already exists is never overwritten", () => {
		assert.deepEqual(migrateLegacyJournals(), { migrated: [], skipped: ["jrnl_broken"] });
		// An interrupted earlier run: the notebook was written, the JSON not yet moved.
		const stale = { ...legacyB, title: "Stale copy" };
		fs.writeFileSync(path.join(LEGACY, "jrnl_legacy_b.json"), JSON.stringify(stale));
		const before = fs.readFileSync(notebookPyFile("jrnl_legacy_b"), "utf-8");
		assert.deepEqual(migrateLegacyJournals().migrated, ["jrnl_legacy_b"]);
		assert.equal(fs.readFileSync(notebookPyFile("jrnl_legacy_b"), "utf-8"), before);
		assert.equal(notebookStore.getJournal("jrnl_legacy_b")!.title, legacyB.title);
		assert.equal(fs.readdirSync(BACKUP).filter((f) => f.startsWith("jrnl_legacy_b.")).length, 2, "the earlier backup is kept too");
	});

	it("a run that crashed after the .py but before the sidecar is redone from the JSON", () => {
		const legacyC = journal("jrnl_legacy_c", [cell("c1", "reflection", "Rated", { understanding: { level: "own", hash: "h", at: T } })], {
			chatId: "chat_c",
			publications: [{ at: T, siteRepo: "/site", path: "content/posts/2026-11-15-c" }],
		});
		fs.writeFileSync(notebookPyFile("jrnl_legacy_c"), journalToMarimo(legacyC).py);
		fs.writeFileSync(path.join(LEGACY, "jrnl_legacy_c.json"), JSON.stringify(legacyC));
		assert.deepEqual(migrateLegacyJournals().migrated, ["jrnl_legacy_c"]);
		assert.deepEqual(notebookStore.getJournal("jrnl_legacy_c"), legacyC);
	});
});

describe("notebook store: writes and hand edits", () => {
	it("create / save / delete keep the .py and the sidecar together; atomic writes leave no temp files", () => {
		const j = journal("jrnl_new", [cell("cell_n00000000001", "reflection", "Hello")], { chatId: "chat_new" });
		notebookStore.createJournal(j);
		assert.throws(() => notebookStore.createJournal(j));
		assert.deepEqual(notebookStore.getJournal("jrnl_new"), j);
		const edited = { ...j, cells: [...j.cells, cell("cell_n00000000002", "code", "y = 2", { lang: "python" })], updatedAt: "2026-11-15T12:00:00.000Z" };
		notebookStore.saveJournal(edited);
		assert.deepEqual(notebookStore.getJournal("jrnl_new"), edited);
		assert.equal(notebookStore.findJournalByChat("chat_new")?.id, "jrnl_new");
		assert.ok(!fs.readdirSync(NOTEBOOKS).some((f) => f.includes(".tmp-")));
		assert.equal(notebookStore.deleteJournal("jrnl_new"), true);
		assert.equal(fs.existsSync(notebookPyFile("jrnl_new")), false);
		assert.equal(fs.existsSync(notebookSidecarFile("jrnl_new")), false);
		assert.equal(notebookStore.isChatOptedOut("chat_new"), true);
		assert.equal(notebookStore.getJournal("../etc"), null);
	});

	it("a cell added in marimo gets an id that is written back, so it stays stable", () => {
		const j = journal("jrnl_hand", [cell("cell_h00000000001", "reflection", "One"), cell("cell_h00000000002", "code", "a = 1", { lang: "python" })]);
		notebookStore.createJournal(j);
		const file = notebookPyFile("jrnl_hand");
		const py = fs.readFileSync(file, "utf-8").replace('\n\n\nif __name__', '\n\n\n@app.cell\ndef _(a):\n    b = a + 1\n    return (b,)\n\n\nif __name__');
		fs.writeFileSync(file, py);
		const first = notebookStore.getJournal("jrnl_hand")!;
		assert.equal(first.cells.length, 3);
		const added = first.cells[2]!;
		assert.deepEqual([added.role, added.source], ["code", "b = a + 1"]);
		assert.match(fs.readFileSync(file, "utf-8"), new RegExp(`def ${added.id}\\(a\\):`));
		assert.deepEqual(notebookStore.getJournal("jrnl_hand"), first);
	});

	it("text edited in marimo: only the sidecar is rewritten (the .py keeps marimo's bytes)", () => {
		const file = notebookPyFile("jrnl_hand");
		const py = fs.readFileSync(file, "utf-8").replace("    One\n", "    One, edited\n").replace("def cell_h00000000002():", "def cell_h00000000002(\n):");
		fs.writeFileSync(file, py);
		const j = notebookStore.getJournal("jrnl_hand")!;
		assert.equal(j.cells[0]!.source, "One, edited");
		assert.equal(fs.readFileSync(file, "utf-8"), py);
		const sidecar = JSON.parse(fs.readFileSync(notebookSidecarFile("jrnl_hand"), "utf-8"));
		assert.equal(sidecar.cells[0].updatedAt, j.cells[0]!.updatedAt);
		assert.notEqual(j.cells[0]!.updatedAt, T);
	});

	it("a marimo notebook with no sidecar loads, and gets one", () => {
		const { py } = journalToMarimo(journal("x", [cell("cell_m00000000001", "reflection", "From marimo")]));
		fs.writeFileSync(notebookPyFile("jrnl_bare"), py);
		const j = notebookStore.getJournal("jrnl_bare")!;
		assert.equal(j.id, "jrnl_bare");
		assert.deepEqual(j.cells.map((c) => [c.id, c.source]), [["cell_m00000000001", "From marimo"]]);
		assert.ok(fs.existsSync(notebookSidecarFile("jrnl_bare")));
	});

	it("a corrupt sidecar is read around, never overwritten", () => {
		fs.writeFileSync(notebookSidecarFile("jrnl_bare"), "{ broken");
		assert.equal(notebookStore.getJournal("jrnl_bare")!.cells.length, 1);
		assert.equal(fs.readFileSync(notebookSidecarFile("jrnl_bare"), "utf-8"), "{ broken");
	});
});

describe("marimo-clean check (python3 ast)", { skip: !hasPython && "python3 not available" }, () => {
	it("finds globals two Python cells define, `mo`, and unparsable cells; ignores locals and _names", async () => {
		const j = journal("jrnl_check", [
			cell("p1", "code", "import numpy as np\nx = 1\n_tmp = 0\ndef f():\n    inner = 1", { lang: "python" }),
			cell("p2", "code", "x = 2\nfor i in range(3):\n    pass\n_tmp = 1\n[inner for inner in range(2)]", { lang: "python" }),
			cell("p3", "code", "import marimo as mo\nnp = None\ni = 0", { lang: "py" }),
			cell("p4", "code", "def broken(:\n    pass", { lang: "python" }),
			cell("cpp", "code", "int x = 1;", { lang: "cpp" }),
			cell("md", "reflection", "x = 1"),
		]);
		const r = await marimoCleanCheck(j);
		assert.equal(r.checked, true);
		assert.deepEqual(r.redefinitions, [
			{ name: "i", cellIds: ["p2", "p3"] },
			{ name: "mo", cellIds: ["p3"], reserved: true },
			{ name: "np", cellIds: ["p1", "p3"] },
			{ name: "x", cellIds: ["p1", "p2"] },
		]);
		assert.deepEqual(r.unparsable.map((u) => u.cellId), ["p4"]);
		assert.equal(await marimoCleanCheck(j), r, "cached by text");
	});

	it("a clean notebook reports nothing", async () => {
		const r = await marimoCleanCheck(journal("jrnl_clean", [cell("a", "code", "x = 1", { lang: "python" }), cell("b", "code", "y = x + 1", { lang: "python" })]));
		assert.deepEqual(r, { checked: true, redefinitions: [], unparsable: [] });
	});
});
