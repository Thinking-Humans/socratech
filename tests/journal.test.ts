/**
 * Learn-in-public journal (docs/learn-in-public.md, 2026-11-15): pure ops
 * (core/journal.ts), the bundle exporter (core/journal-export.ts), and the
 * fs store (store/journals.ts) under an isolated LH_DATA_DIR.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-journal-"));
process.env.LH_DATA_DIR = TMP_DATA;

const {
	JournalError,
	appendCell,
	moveCell,
	newJournal,
	removeCell,
	slugify,
	summarizeJournal,
	updateCell,
	updateJournalMeta,
	upsertOriginCell,
} = await import("../src/core/journal.ts");
const { exportJournal, renderJournalMarkdown, bundleTags } = await import("../src/core/journal-export.ts");
const { journalStore } = await import("../src/store/journals.ts");
const { subscribe } = await import("../src/core/events.ts");
type ServerEvent<K extends import("../src/core/events.ts").ServerEventType> = import("../src/core/events.ts").ServerEvent<K>;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const T = "2026-11-15T10:00:00.000Z";
const T2 = "2026-11-15T11:00:00.000Z";

function sample() {
	let j = newJournal({ id: "jrnl_a", title: "Spectral graph theory: Laplacians", chatId: "chat_x", now: T });
	j = appendCell(j, { id: "c1", role: "exercise", source: "Show $L = D - A$ is PSD.", origin: { chatId: "chat_x", toolCallId: "t1", ideaIds: ["n_lap"] } }, T);
	j = appendCell(j, { id: "c2", role: "attempt", source: "x^T L x = sum over edges...", origin: { chatId: "chat_x", toolCallId: "t1", ideaIds: ["n_lap"] } }, T);
	j = appendCell(j, { id: "c3", role: "verdict", source: "Pass.", origin: { chatId: "chat_x", toolCallId: "t1", ideaIds: ["n_lap"] } }, T);
	j = appendCell(j, { id: "c4", role: "reflection", source: "The quadratic form is a **sum of squares**:\n\n$$x^\\top L x = \\sum_{(i,j)} (x_i - x_j)^2$$" }, T);
	j = appendCell(j, { id: "c5", role: "aside", source: "Ask about normalized Laplacian later." }, T);
	j = appendCell(j, { id: "c6", role: "code", lang: "python", source: "import numpy as np\nprint(np.linalg.eigvalsh(L))", output: "[0. 1. 3.]" }, T);
	return j;
}

describe("journal ops", () => {
	it("slugify makes URL-safe slugs with a floor", () => {
		assert.equal(slugify("Spectral graph theory: Laplacians!"), "spectral-graph-theory-laplacians");
		assert.equal(slugify("Café — naïve"), "cafe-naive");
		assert.equal(slugify("   ∑∏  "), "journal");
	});

	it("cells take their role's default visibility", () => {
		const j = sample();
		const vis = Object.fromEntries(j.cells.map((c) => [c.role, c.publish]));
		assert.deepEqual(vis, { exercise: true, attempt: false, verdict: false, reflection: true, aside: false, code: true });
	});

	it("append after, update, move, remove", () => {
		let j = sample();
		j = appendCell(j, { id: "c7", role: "reflection", source: "inserted" }, T2, "c1");
		assert.equal(j.cells[1]!.id, "c7");
		j = updateCell(j, "c5", { publish: true, source: "now public" }, T2);
		assert.equal(j.cells.find((c) => c.id === "c5")!.publish, true);
		j = updateCell(j, "c6", { output: "" }, T2);
		assert.equal("output" in j.cells.find((c) => c.id === "c6")!, false);
		j = moveCell(j, "c6", 0, T2);
		assert.equal(j.cells[0]!.id, "c6");
		j = moveCell(j, "c6", 99, T2);
		assert.equal(j.cells.at(-1)!.id, "c6");
		j = removeCell(j, "c7", T2);
		assert.equal(j.cells.some((c) => c.id === "c7"), false);
		assert.equal(j.updatedAt, T2);
	});

	it("refuses unknown cells, duplicate ids, bad roles and slugs", () => {
		const j = sample();
		assert.throws(() => updateCell(j, "nope", { source: "x" }, T2), JournalError);
		assert.throws(() => appendCell(j, { id: "c1", role: "aside", source: "dup" }, T2), JournalError);
		// @ts-expect-error — runtime guard for untyped callers (routes, MCP)
		assert.throws(() => appendCell(j, { id: "c9", role: "essay", source: "x" }, T2), JournalError);
		assert.throws(() => updateJournalMeta(j, { slug: "Bad Slug" }, T2), JournalError);
		assert.throws(() => updateJournalMeta(j, { title: "  " }, T2), JournalError);
	});

	it("upsertOriginCell is idempotent per (chat, toolCall, role)", () => {
		const j = sample();
		const again = upsertOriginCell(j, { id: "c99", role: "exercise", source: "changed", origin: { chatId: "chat_x", toolCallId: "t1", ideaIds: [] } }, T2);
		assert.equal(again.added, false);
		assert.equal(again.journal, j);
		const fresh = upsertOriginCell(j, { id: "c99", role: "exercise", source: "next", origin: { chatId: "chat_x", toolCallId: "t2", ideaIds: [] } }, T2);
		assert.equal(fresh.added, true);
		assert.equal(fresh.journal.cells.length, j.cells.length + 1);
	});

	it("summarizes", () => {
		const s = summarizeJournal(sample());
		assert.equal(s.cellCount, 6);
		assert.equal(s.publishedCellCount, 3);
		assert.equal(s.chatId, "chat_x");
	});
});

describe("journal export", () => {
	it("markdown bundle: front matter + published cells only", () => {
		const b = exportJournal(sample(), { date: "2026-11-15", format: "markdown", ideaNames: { n_lap: "graph Laplacian" } });
		assert.equal(b.dir, "2026-11-15-spectral-graph-theory-laplacians");
		assert.deepEqual(Object.keys(b.files), ["index.md"]);
		const md = b.files["index.md"]!;
		assert.match(md, /^---\ntitle: "Spectral graph theory: Laplacians"\ndate: 2026-11-15\ntags: \["graph Laplacian"\]\ndraft: false\nsocratech:\n {2}journal: "jrnl_a"\n {2}ideas: \["n_lap"\]\n---\n/);
		assert.match(md, /<div class="exercise" markdown="1">\n\n\*\*Exercise 1\*\*\n\nShow \$L = D - A\$ is PSD\.\n\n<\/div>/);
		assert.match(md, /\$\$x\^\\top L x = \\sum_\{\(i,j\)\} \(x_i - x_j\)\^2\$\$/);
		assert.match(md, /```python\nimport numpy as np\nprint\(np\.linalg\.eigvalsh\(L\)\)\n```/);
		assert.match(md, /<div class="output" markdown="1">\n\n```text\n\[0\. 1\. 3\.\]\n```\n\n<\/div>/);
		assert.doesNotMatch(md, /sum over edges|Pass\.|normalized Laplacian/);
	});

	it("published aside renders as a margin note; private cells opt in", () => {
		let j = sample();
		j = updateCell(j, "c5", { publish: true }, T2);
		j = updateCell(j, "c3", { publish: true }, T2);
		const md = renderJournalMarkdown(j);
		assert.match(md, /<aside class="note" markdown="1">\n\nAsk about normalized Laplacian later\.\n\n<\/aside>/);
		assert.match(md, /<div class="verdict" markdown="1">\n\n\*\*Verdict\*\*\n\nPass\./);
	});

	it("code fences outgrow backtick runs inside the code", () => {
		let j = newJournal({ id: "jrnl_b", title: "Fences", now: T });
		j = appendCell(j, { id: "c1", role: "code", lang: "markdown", source: "```js\nx\n```" }, T);
		assert.match(renderJournalMarkdown(j), /^````markdown\n```js\nx\n```\n````\n$/);
	});

	it("titles with quotes stay valid YAML-quoted", () => {
		const j = newJournal({ id: "jrnl_c", title: 'Why "spectral"? #1: a note', now: T });
		const md = exportJournal(j, { date: "2026-11-15T09:00:00+05:30", format: "markdown" }).files["index.md"]!;
		assert.match(md, /^---\ntitle: "Why \\"spectral\\"\? #1: a note"\ndate: 2026-11-15T09:00:00\+05:30\n/);
	});

	it("notebook bundle: front-matter-only index.md + tagged ipynb", () => {
		const b = exportJournal(sample(), { date: "2026-11-15", format: "notebook" });
		assert.deepEqual(Object.keys(b.files).sort(), ["index.md", "notebook.ipynb"]);
		assert.match(b.files["index.md"]!, /---\n$/);
		const nb = JSON.parse(b.files["notebook.ipynb"]!);
		assert.equal(nb.nbformat, 4);
		assert.equal(nb.metadata.language_info.name, "python");
		assert.deepEqual(nb.cells.map((c: { metadata: { tags: string[] } }) => c.metadata.tags[0]), ["exercise", "reflection", "code"]);
		const code = nb.cells[2];
		assert.equal(code.cell_type, "code");
		assert.deepEqual(code.source, ["import numpy as np\n", "print(np.linalg.eigvalsh(L))"]);
		assert.deepEqual(code.outputs[0].text, ["[0. 1. 3.]\n"]);
		assert.equal(nb.cells[0].source[0], "**Exercise 1**\n");
	});

	it("empty published cells are skipped; tags merge and dedupe", () => {
		let j = sample();
		j = appendCell(j, { id: "c8", role: "reflection", source: "   " }, T);
		j = updateJournalMeta(j, { tags: ["linear algebra", " graph Laplacian ", ""] }, T);
		assert.equal(renderJournalMarkdown(j).includes("\n\n\n\n"), false);
		assert.deepEqual(bundleTags(j, { n_lap: "graph Laplacian" }), ["linear algebra", "graph Laplacian"]);
	});

	it("refuses a malformed date", () => {
		assert.throws(() => exportJournal(sample(), { date: "15/11/2026", format: "markdown" }));
	});
});

describe("journal store", () => {
	it("create → get → find by chat → list → save → delete, announcing each write", () => {
		const seen: string[] = [];
		const off = subscribe((e) => {
			if (e.type === "journals-changed") seen.push((e as ServerEvent<"journals-changed">).journalId);
		});
		try {
			const j = journalStore.createJournal(sample());
			assert.throws(() => journalStore.createJournal(j));
			assert.deepEqual(journalStore.getJournal("jrnl_a"), j);
			assert.equal(journalStore.findJournalByChat("chat_x")?.id, "jrnl_a");
			assert.equal(journalStore.findJournalByChat("chat_none"), null);

			journalStore.createJournal(newJournal({ id: "jrnl_z", title: "Later", now: T2 }));
			assert.deepEqual(journalStore.listJournals().map((s) => s.id), ["jrnl_z", "jrnl_a"]);

			const edited = updateCell(j, "c4", { source: "rewritten" }, "2026-11-15T12:00:00.000Z");
			journalStore.saveJournal(edited);
			assert.equal(journalStore.getJournal("jrnl_a")!.cells[3]!.source, "rewritten");
			assert.deepEqual(journalStore.listJournals().map((s) => s.id), ["jrnl_a", "jrnl_z"]);
			assert.throws(() => journalStore.saveJournal({ ...j, id: "jrnl_unknown" }));

			assert.equal(journalStore.deleteJournal("jrnl_z"), true);
			assert.equal(journalStore.deleteJournal("jrnl_z"), false);
			assert.equal(journalStore.getJournal("jrnl_z"), null);
			assert.equal(journalStore.getJournal("../etc"), null);
			assert.deepEqual(seen, ["jrnl_a", "jrnl_z", "jrnl_a", "jrnl_z"]);
			assert.deepEqual(fs.readdirSync(path.join(TMP_DATA, "journals")).sort(), ["jrnl_a.json"]);
		} finally {
			off();
		}
	});
});

// ─── phase 2: session auto-fill ─────────────────────────────────────────────

const { sessionJournalDrafts } = await import("../src/core/journal-fill.ts");
const { newThinkingMessage } = await import("../src/core/native-messages.ts");
const { fillJournalFromChat } = await import("../src/server/journals.ts");
const { chatStore } = await import("../src/store/chats.ts");
type Msg = import("../src/core/native-messages.ts").LhMessage;

let mid = 0;
function call(name: string, id: string, args: Record<string, unknown>): Msg {
	return { id: `m${++mid}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: 0 } as unknown as Msg;
}
function result(name: string, id: string, isError = false): Msg {
	return { id: `m${++mid}`, role: "toolResult", toolCallId: id, toolName: name, content: [], isError, timestamp: 0 } as unknown as Msg;
}

function improviseSession(): Msg[] {
	return [
		call("problem", "p1", { statement: "Explain PSD-ness of $L$ as a recipe.", target: ["n_lap"], criteria: "Sum of squares survives." }),
		result("problem", "p1"),
		newThinkingMessage("p1", "draft: hmm"),
		newThinkingMessage("p1", "Each edge adds $(x_i-x_j)^2 \\ge 0$."),
		call("conclude", "c1", { outcome: "pass", verdict: "Core carried over." }),
		result("conclude", "c1"),
		call("rejudge", "r1", { contest: "I also covered weights!", verdict: "pass", rationale: "Upheld; weights were extra." }),
		result("rejudge", "r1"),
		call("problem", "p2", { statement: "Refused pose", target: ["n_x"] }),
		result("problem", "p2", true),
		call("problem", "p3", { statement: "What if edges had negative weights?", target: ["n_lap", "n_psd"], modelSolution: "PSD can fail." }),
		result("problem", "p3"),
		call("conclude", "c3", { outcome: "dismissed" }),
		result("conclude", "c3"),
	];
}

describe("journal auto-fill drafts", () => {
	it("exercise / last attempt / verdict + reveal / rejudge; errored and dismissed yield nothing", () => {
		const drafts = sessionJournalDrafts("chat_gym", improviseSession());
		assert.deepEqual(drafts.map((d) => [d.role, d.origin.toolCallId]), [
			["exercise", "p1"],
			["attempt", "p1"],
			["verdict", "p1"],
			["verdict", "r1"],
			["exercise", "p3"],
		]);
		assert.equal(drafts[1]!.source, "Each edge adds $(x_i-x_j)^2 \\ge 0$.");
		assert.equal(drafts[2]!.source, "**Pass.** Core carried over.\n\n> **Criteria**\n>\n> Sum of squares survives.");
		assert.match(drafts[3]!.source, /^\*\*Rejudged: Pass\.\*\* Upheld; weights were extra\.\n\n> \*\*Contest\*\*/);
		assert.deepEqual(drafts[3]!.origin.ideaIds, ["n_lap"]);
		assert.deepEqual(drafts[4]!.origin.ideaIds, ["n_lap", "n_psd"]);
	});
});

describe("journal auto-fill seam", () => {
	it("creates the session journal on first fill, then only appends new cells", () => {
		const chat = chatStore.createChat("Gym: Laplacians", "improvise");
		const msgs = improviseSession();
		chatStore.saveMessages(chat.id, msgs.slice(0, 2));
		const first = fillJournalFromChat({ chatStore, journalStore }, chat.id, T);
		assert.ok(first);
		assert.equal(first.title, "Gym: Laplacians");
		assert.equal(first.chatId, chat.id);
		assert.deepEqual(first.cells.map((c) => c.role), ["exercise"]);

		// learner edits the exercise cell — the next fill must not clobber it
		journalStore.saveJournal(updateCell(first, first.cells[0]!.id, { source: "edited" }, T2));
		chatStore.saveMessages(chat.id, msgs);
		const second = fillJournalFromChat({ chatStore, journalStore }, chat.id, T2);
		assert.ok(second);
		assert.equal(second.id, first.id);
		assert.deepEqual(second.cells.map((c) => c.role), ["exercise", "attempt", "verdict", "verdict", "exercise"]);
		assert.equal(second.cells[0]!.source, "edited");
		assert.deepEqual(second.cells.map((c) => c.publish), [true, false, false, false, true]);

		assert.equal(fillJournalFromChat({ chatStore, journalStore }, chat.id, T2), null, "replay adds nothing");
	});

	it("skips teaching chats", () => {
		const chat = chatStore.createChat("Teach me Laplacians");
		chatStore.saveMessages(chat.id, improviseSession());
		assert.equal(fillJournalFromChat({ chatStore, journalStore }, chat.id, T), null);
		assert.equal(journalStore.findJournalByChat(chat.id), null);
	});
});

// ─── routes: one operation per request (the lost-update law) ────────────────

const listRoute = await import("../app/api/journals/route.ts");
const oneRoute = await import("../app/api/journals/[id]/route.ts");
const cellsRoute = await import("../app/api/journals/[id]/cells/route.ts");
const cellRoute = await import("../app/api/journals/[id]/cells/[cellId]/route.ts");

const json = (method: string, body?: unknown) =>
	new Request("http://test/api/journals", {
		method,
		headers: { "Content-Type": "application/json" },
		...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
	});
const ctx = <P extends Record<string, string>>(p: P) => ({ params: Promise.resolve(p) });

describe("journal routes", () => {
	it("create → add → patch → stale 409 → move → delete cell", async () => {
		let res = await listRoute.POST(json("POST", { title: "Standalone notes" }));
		assert.equal(res.status, 201);
		const { journal } = (await res.json()) as { journal: { id: string; slug: string } };
		assert.equal(journal.slug, "standalone-notes");
		const id = journal.id;

		res = await cellsRoute.POST(json("POST", { role: "reflection", source: "first" }), ctx({ id }));
		assert.equal(res.status, 201);
		res = await cellsRoute.POST(json("POST", { role: "aside", source: "second" }), ctx({ id }));
		let j = ((await res.json()) as { journal: { cells: { id: string; updatedAt: string; publish: boolean }[] } }).journal;
		const [a, b] = j.cells;
		assert.equal(b!.publish, false);

		res = await cellRoute.PATCH(json("PATCH", { publish: true, ifUpdatedAt: b!.updatedAt }), ctx({ id, cellId: b!.id }));
		assert.equal(res.status, 200);
		res = await cellRoute.PATCH(json("PATCH", { source: "stale", ifUpdatedAt: "1999-01-01T00:00:00.000Z" }), ctx({ id, cellId: b!.id }));
		assert.equal(res.status, 409);

		res = await cellRoute.PATCH(json("PATCH", { toIndex: 0 }), ctx({ id, cellId: b!.id }));
		j = ((await res.json()) as typeof j & { journal: typeof j }).journal;
		assert.deepEqual(j.cells.map((c) => c.id), [b!.id, a!.id]);

		res = await cellRoute.DELETE(json("DELETE"), ctx({ id, cellId: a!.id }));
		assert.equal(res.status, 200);
		res = await oneRoute.GET(json("GET"), ctx({ id }));
		assert.equal(((await res.json()) as { journal: { cells: unknown[] } }).journal.cells.length, 1);

		res = await oneRoute.DELETE(json("DELETE"), ctx({ id }));
		assert.equal(res.status, 200);
		res = await oneRoute.GET(json("GET"), ctx({ id }));
		assert.equal(res.status, 404);
	});

	it("validation: bad role, bad JSON, unknown cell, non-boolean publish → 400/404", async () => {
		const res0 = await listRoute.POST(json("POST", { title: "Validation" }));
		const id = ((await res0.json()) as { journal: { id: string } }).journal.id;
		assert.equal((await cellsRoute.POST(json("POST", { role: "essay" }), ctx({ id }))).status, 400);
		assert.equal((await cellsRoute.POST(json("POST", "{nope"), ctx({ id }))).status, 400);
		assert.equal((await cellsRoute.POST(json("POST", { role: "code", publish: "yes" }), ctx({ id }))).status, 400);
		assert.equal((await cellRoute.PATCH(json("PATCH", { source: "x" }), ctx({ id, cellId: "cell_nope" }))).status, 404);
		assert.equal((await cellsRoute.POST(json("POST", { role: "reflection" }), ctx({ id: "jrnl_nope" }))).status, 404);
	});

	it("one journal per session; lookup by chatId; slug pinned after publish", async () => {
		const chat = chatStore.createChat("Teach me eigenvalues");
		let res = await listRoute.POST(json("POST", { title: "Eigen notes", chatId: chat.id }));
		assert.equal(res.status, 201);
		const id = ((await res.json()) as { journal: { id: string } }).journal.id;
		assert.equal((await listRoute.POST(json("POST", { title: "Again", chatId: chat.id }))).status, 409);
		assert.equal((await listRoute.POST(json("POST", { title: "Ghost", chatId: "chat_ghost" }))).status, 404);

		res = await listRoute.GET(new Request(`http://test/api/journals?chatId=${chat.id}`));
		assert.equal(((await res.json()) as { journal: { id: string } }).journal.id, id);

		assert.equal((await oneRoute.PATCH(json("PATCH", { slug: "eigen" }), ctx({ id }))).status, 200);
		const j = journalStore.getJournal(id)!;
		journalStore.saveJournal({ ...j, publications: [{ at: T, siteRepo: "/site", path: "content/posts/2026-11-15-eigen" }] });
		assert.equal((await oneRoute.PATCH(json("PATCH", { slug: "eigen-2" }), ctx({ id }))).status, 400);
		assert.equal((await oneRoute.PATCH(json("PATCH", { slug: "eigen", title: "Eigen, retitled" }), ctx({ id }))).status, 200);
	});
});

describe("journal export — republish pinning", () => {
	it("dirName pins the directory; lastmod rides the front matter", () => {
		const b = exportJournal(sample(), { date: "2026-11-01", format: "markdown", dirName: "2026-11-01-old-slug", lastmod: "2026-11-15" });
		assert.equal(b.dir, "2026-11-01-old-slug");
		assert.match(b.files["index.md"]!, /\ndate: 2026-11-01\nlastmod: 2026-11-15\n/);
	});
});

describe("deleted session journals stay deleted (owner, 2026-11-15)", () => {
	it("delete → fill skips; Start journal by hand lifts the opt-out", async () => {
		const { createJournal: startJournal } = await import("../src/server/journals.ts");
		const chat = chatStore.createChat("Gym: tombstone", "improvise");
		chatStore.saveMessages(chat.id, improviseSession());
		const j = fillJournalFromChat({ chatStore, journalStore }, chat.id, T)!;
		assert.equal(journalStore.deleteJournal(j.id), true);
		assert.equal(journalStore.isChatOptedOut(chat.id), true);
		assert.equal(fillJournalFromChat({ chatStore, journalStore }, chat.id, T2), null);
		assert.equal(journalStore.findJournalByChat(chat.id), null);
		assert.ok(!journalStore.listJournals().some((s) => s.id.startsWith("_")), "tombstone file is not a journal");

		const manual = startJournal({ title: "Back by hand", chatId: chat.id });
		assert.equal(journalStore.isChatOptedOut(chat.id), false);
		const filled = fillJournalFromChat({ chatStore, journalStore }, chat.id, T2)!;
		assert.equal(filled.id, manual.id);
		assert.equal(filled.cells.length, 5);
	});
});
