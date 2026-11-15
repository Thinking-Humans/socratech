/**
 * Notes-first (docs/notes-first.md): the vault seam (path guard, daily note,
 * mtime-guarded writes) and the pure /ask helpers.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { NoteError, ensureDailyNote, listNotes, readNote, resolveNotePath, vaultDir, writeNote } = await import("../src/server/index.ts");
const { askContext, askPrompt, calloutBody, calloutHead } = await import("../src/core/index.ts");
const notesRoute = await import("../app/api/notes/route.ts");

describe("vault paths", () => {
	it("resolves inside the vault and refuses escapes", () => {
		const root = vaultDir();
		assert.equal(resolveNotePath("daily/2026-11-15.md"), path.join(root, "daily", "2026-11-15.md"));
		for (const bad of ["../x.md", "a/../../x.md", "/etc/passwd.md", "notes.txt", ".hidden/x.md", "a/./b.md", ""]) {
			assert.throws(() => resolveNotePath(bad), NoteError, bad);
		}
	});
	it("refuses a symlink that leaves the vault", () => {
		const outside = fs.mkdtempSync(path.join(TMP, "outside-"));
		fs.symlinkSync(outside, path.join(vaultDir(), "link"));
		assert.throws(() => resolveNotePath("link/x.md"), /leaves the vault/);
	});
});

describe("notes store", () => {
	it("creates the daily note once, with a heading and an open section", () => {
		const a = ensureDailyNote("2026-11-15");
		assert.equal(a.path, "daily/2026-11-15.md");
		assert.equal(a.content, "# 2026-11-15\n\n## ");
		writeNote(a.path, "# 2026-11-15\n\n## Nix\nflakes", a.mtime);
		assert.equal(ensureDailyNote("2026-11-15").content, "# 2026-11-15\n\n## Nix\nflakes", "existing note is kept");
		assert.throws(() => ensureDailyNote("15-11-2026"), NoteError);
	});
	it("refuses a write when the file changed on disk since load", () => {
		const n = writeNote("topics/fft.md", "v1");
		fs.utimesSync(path.join(vaultDir(), "topics", "fft.md"), new Date(), new Date(Date.now() + 5000));
		assert.throws(() => writeNote("topics/fft.md", "v2", n.mtime), (e: unknown) => e instanceof NoteError && e.code === "conflict");
		assert.equal(readNote("topics/fft.md")?.content, "v1");
		assert.equal(writeNote("topics/fft.md", "v3").content, "v3", "an unguarded write lands");
	});
	it("lists .md files only, hidden dirs skipped", () => {
		fs.mkdirSync(path.join(vaultDir(), ".obsidian"), { recursive: true });
		fs.writeFileSync(path.join(vaultDir(), ".obsidian", "x.md"), "");
		fs.writeFileSync(path.join(vaultDir(), "img.png"), "");
		const paths = listNotes().map((n) => n.path).sort();
		assert.deepEqual(paths, ["daily/2026-11-15.md", "topics/fft.md"]);
	});
	it("routes: GET ?daily, PUT conflict → 409, bad path → 400", async () => {
		const got = (await (await notesRoute.GET(new Request("http://x/api/notes?daily=2026-11-16"))).json()) as { note: { path: string; mtime: number } };
		assert.equal(got.note.path, "daily/2026-11-16.md");
		const put = (body: unknown) => notesRoute.PUT(new Request("http://x/api/notes", { method: "PUT", body: JSON.stringify(body) }));
		assert.equal((await put({ path: got.note.path, content: "x", ifMtime: got.note.mtime })).status, 200);
		assert.equal((await put({ path: got.note.path, content: "y", ifMtime: 1 })).status, 409);
		assert.equal((await put({ path: "../x.md", content: "y" })).status, 400);
	});
});

describe("/ask helpers", () => {
	const doc = "# 2026-11-15\n\n## Nix flakes\nflakes pin inputs\n/ask why not pin a rev?\nmore\n\n## FFT\nbutterflies";
	it("finds the question, its section and the note title", () => {
		const ctx = askContext(doc, 5);
		assert.deepEqual(ctx, { question: "why not pin a rev?", topic: "Nix flakes", section: "## Nix flakes\nflakes pin inputs\nmore", title: "2026-11-15" });
		assert.equal(askContext(doc, 4), null, "not an /ask line");
		assert.match(askPrompt(ctx!), /Section: Nix flakes[\s\S]*Question: why not pin a rev\?/);
	});
	it("renders the answer as a callout", () => {
		assert.equal(calloutHead("q?"), "> [!claude] q?");
		assert.equal(calloutBody("a\n\nb\n"), "> a\n>\n> b");
	});
});

describe("journeys in notes", async () => {
	const { journeyMarker, journeySection, journeyPrompt } = await import("../src/core/index.ts");
	const doc = ["# 2026-11-15", "## Chain rule", journeyMarker("teach", "abc-1"), "derivative of f(g(x))", journeyMarker("practice", "p_2"), "## Next", "x"].join("\n");

	it("reads the section, strips markers, lists journeys", () => {
		const s = journeySection(doc, 2)!;
		assert.equal(s.topic, "Chain rule");
		assert.equal(s.section, "derivative of f(g(x))");
		assert.deepEqual(s.journeys, [
			{ kind: "teach", chatId: "abc-1", line: 3 },
			{ kind: "practice", chatId: "p_2", line: 5 },
		]);
		assert.equal(journeySection(doc, 1), null);
		assert.deepEqual(journeySection(doc, 6)!.journeys, []);
	});

	it("prompts differ by kind and carry the notes", () => {
		for (const k of ["teach", "practice", "improvise"] as const) assert.match(journeyPrompt(k, "T", "body"), /body/);
		assert.notEqual(journeyPrompt("practice", "T", ""), journeyPrompt("teach", "T", ""));
	});
});
