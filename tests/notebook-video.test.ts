/**
 * Notebook video (owner, 2026-11-21): the agent's notebook.md covers every
 * cell (private ones marked), its media list, the progress lines, and the
 * job API's refusals before anything spawns.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-video-"));
process.env.LH_DATA_DIR = TMP;
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const core = await import("../src/core/notebook-video.ts");
const { createJournal, addJournalCell } = await import("../src/server/journals.ts");
const video = await import("../src/server/notebook-video.ts");

const NOW = "2026-11-21T00:00:00.000Z";
const cell = (id: string, role: "reflection" | "code" | "agent", source: string, extra: object = {}) => ({ id, role, source, publish: true, createdAt: NOW, updatedAt: NOW, ...extra });

describe("notebook video source", () => {
	const journal = {
		id: "jrnl_v",
		title: "Recursion",
		cells: [
			cell("a", "reflection", "## Base case\nEvery recursion needs one. ![plot](media/plot-ab12cd.png)", { understanding: { level: "helped", hash: "h", at: NOW } }),
			cell("b", "code", "def f(n):\n    return 1 if n == 0 else n * f(n - 1)", { lang: "python", output: "120" }),
			cell("c", "agent", "why does it stop?", { output: "Because n reaches 0.", publish: false }),
			cell("d", "reflection", "![Recursion](media/recursion-1a2b3c.html)"),
		],
	} as never;

	it("covers every cell in order, private ones marked, with outputs and confidence", () => {
		const md = core.notebookVideoSource(journal);
		assert.match(md, /^# Recursion\n/);
		assert.match(md, /## Cell 1 \(markdown\)\n\n## Base case/);
		assert.match(md, /_Learner's confidence: 50%_/);
		assert.match(md, /## Cell 2 \(code, python\)\n\n```python\ndef f\(n\):/);
		assert.match(md, /Output:\n```\n120\n```/);
		assert.match(md, /## Cell 3 \(agent question\) <!-- private -->/);
		assert.match(md, /\*\*Agent answer:\*\*\n\nBecause n reaches 0\./);
		assert.ok(md.indexOf("Cell 1") < md.indexOf("Cell 2") && md.indexOf("Cell 2") < md.indexOf("Cell 3"));
	});
	it("lists the media it refers to, visuals included", () => {
		assert.deepEqual(core.notebookVideoMedia(journal), ["plot-ab12cd.png", "recursion-1a2b3c.html"]);
	});
	it("turns agent stream events into short progress lines", () => {
		const ev = (content: unknown[]) => ({ type: "assistant", message: { content } });
		assert.equal(core.videoProgressLine(ev([{ type: "tool_use", name: "Bash", input: { command: "npx --yes hyperframes render --quality delivery -o renders/notebook.mp4" } }])), "Bash: hyperframes render --quality delivery -o renders/notebook.mp4");
		assert.equal(core.videoProgressLine(ev([{ type: "tool_use", name: "Write", input: { file_path: "/x/project/compositions/scene-1.html" } }])), "Write: compositions/scene-1.html");
		assert.equal(core.videoProgressLine(ev([{ type: "text", text: "Writing the script.\nMore." }])), "Writing the script.");
		assert.equal(core.videoProgressLine({ type: "user" }), null);
	});
	it("the update prompt points the agent at request.md and the existing project", () => {
		assert.match(core.notebookVideoPrompt("update"), /request\.md/);
		assert.match(core.notebookVideoPrompt("update"), /re-render renders\/notebook\.mp4/);
		assert.match(core.NOTEBOOK_VIDEO_HEADLESS_RULES, /Never run `preview`/);
	});
});

describe("notebook video jobs", () => {
	it("a fresh notebook is idle; the taste defaults to the shipped skill and can be customised and reset", () => {
		const j = createJournal({ title: "Video" });
		addJournalCell(j.id, { role: "reflection", source: "Hello." });
		const state = video.notebookVideoState(j.id);
		assert.equal(state.status, "idle");
		assert.equal(state.stale, false);
		const t = video.readVideoTaste();
		assert.equal(t.custom, false);
		assert.match(t.text, /name: notebook-video/);
		video.writeVideoTaste("my taste");
		assert.deepEqual([video.readVideoTaste().custom, video.readVideoTaste().text], [true, "my taste"]);
		assert.throws(() => video.writeVideoTaste("  "), /empty/);
		video.writeVideoTaste(null);
		assert.equal(video.readVideoTaste().custom, false);
	});
	it("cancel with nothing running is a no-op", () => {
		const j = createJournal({ title: "Video 2" });
		assert.equal(video.cancelNotebookVideo(j.id).status, "idle");
	});
});
