/**
 * Web clip (docs/web-clip.md): markdown → cells, exercise parsing, html
 * conversion, and the MCP tool end to end on a temp data dir with a fake
 * strong model.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-web-clip-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { pageToCells, parseClipExercises, clipExercisePrompt, cleanHeadingLine, splitDoctest, MAX_CLIP_CELLS, MAX_PROSE_CELL_CHARS } = await import("../src/core/web-clip.ts");
const clip = await import("../src/server/web-clip.ts");
const { createGymMcpServer } = await import("../src/server/mcp.ts");
const { stores } = await import("../src/server/stores.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const META = { url: "https://example.com/post", title: "A Post", clippedAt: "2026-11-15T10:00:00.000Z" };

const PAGE = `Intro line.

## Loops

A loop repeats.

\`\`\`py
for i in range(3):
    print(i)
\`\`\`

After code.

### Detail stays inside

More.

## Credits

Thanks.`;

describe("pageToCells", () => {
	it("source cell, then prose/code cells per ## section", () => {
		const plan = pageToCells(PAGE, META);
		assert.equal(plan.cells[0]!.source, "> Source: [A Post](https://example.com/post) · clipped 2026-11-15");
		assert.deepEqual(
			plan.cells.slice(1).map((c) => [c.role, c.section, c.lang ?? ""]),
			[
				["aside", 0, ""],
				["aside", 1, ""],
				["code", 1, "py"],
				["aside", 1, ""],
				["aside", 1, ""],
				["aside", 2, ""],
			],
		);
		assert.deepEqual(plan.sections.map((s) => s.heading), ["A Post", "Loops", "Credits"]);
		assert.equal(plan.cells[3]!.source, "for i in range(3):\n    print(i)");
		assert.match(plan.cells[5]!.source, /^### Detail stays inside\n\nMore\.$/, "### starts its own cell in the same section");
	});

	it("a heading inside a fence does not split", () => {
		const plan = pageToCells("## A\n\n```md\n## not a heading\n```\n", META);
		assert.equal(plan.sections.length, 1);
		assert.equal(plan.cells.at(-1)!.source, "## not a heading");
	});

	it("folds the tail past MAX_CLIP_CELLS into one cell", () => {
		const md = Array.from({ length: 300 }, (_, i) => `## S${i}\n\nbody ${i}`).join("\n\n");
		const plan = pageToCells(md, META);
		assert.equal(plan.cells.length, MAX_CLIP_CELLS);
		assert.match(plan.cells.at(-1)!.source, /body 299/);
	});
});

describe("real-site shapes", () => {
	it("strips heading chrome: pilcrows, empty anchors, wiki [edit], self-links", () => {
		assert.equal(cleanHeadingLine('## 4.1. `if` Statements[¶](#if-statements "Link to this heading")'), "## 4.1. `if` Statements");
		assert.equal(cleanHeadingLine("## Installation  [](#installation)"), "## Installation");
		assert.equal(cleanHeadingLine('## History  \\[[edit](https://en.wikipedia.org/w/index.php?action=edit&section=5 "Edit section: History")\\]'), "## History");
		assert.equal(cleanHeadingLine("## [Closure](#closure)"), "## Closure");
	});

	it("a >>> session becomes runnable python with its printed output", () => {
		assert.deepEqual(splitDoctest(">>> for i in range(2):\n...     print(i)\n...\n0\n1"), { code: "for i in range(2):\n    print(i)", output: "0\n1" });
		assert.equal(splitDoctest("print(1)"), null);
		const plan = pageToCells("## A\n\n```\n>>> 1 + 1\n2\n```", META);
		assert.deepEqual(plan.cells.at(-1), { role: "code", source: "1 + 1", lang: "python", output: "2", section: 0 });
	});

	it("### starts a new cell in the same section; long prose splits at paragraphs", () => {
		const para = "word ".repeat(300).trim();
		const plan = pageToCells(`## A\n\nintro\n\n### Sub\n\nmore\n\n## B\n\n${Array(8).fill(para).join("\n\n")}`, META);
		assert.deepEqual(plan.sections.map((x) => x.heading), ["A", "B"]);
		const a = plan.cells.filter((c) => c.section === 0);
		assert.equal(a.length, 2);
		assert.match(a[1]!.source, /^### Sub/);
		const b = plan.cells.filter((c) => c.section === 1);
		assert.ok(b.length > 1 && b.every((c) => c.source.length <= MAX_PROSE_CELL_CHARS));
	});

	it("drops back matter sections", () => {
		const plan = pageToCells("## Body\n\ntext\n\n## References\n\n1. cite\n\n```\ncode in refs\n```\n\n## External links\n\n- x", META);
		assert.deepEqual(plan.sections.map((x) => x.heading), ["Body"]);
		assert.ok(!plan.cells.some((c) => /cite|code in refs|- x/.test(c.source)));
	});
});

describe("exercises", () => {
	it("parses one exercise per known section, dropping junk", () => {
		const reply = 'Sure:\n[{"section":1,"exercise":"Do X"},{"section":1,"exercise":"dup"},{"section":9,"exercise":"out"},{"section":0,"exercise":" "},{"section":2,"exercise":"Do Y"}]';
		assert.deepEqual(parseClipExercises(reply, 3), [
			{ section: 1, exercise: "Do X" },
			{ section: 2, exercise: "Do Y" },
		]);
		assert.deepEqual(parseClipExercises("no json", 3), []);
	});

	it("prompt numbers sections", () => {
		const prompt = clipExercisePrompt("T", "https://e.x", pageToCells(PAGE, META).sections);
		assert.match(prompt, /<section number="1" heading="Loops">/);
	});
});

describe("html conversion", () => {
	it("keeps code language through a full-page Readability pass", () => {
		const para = "<p>" + "Real article prose that Readability will keep as content. ".repeat(12) + "</p>";
		const { markdown } = clip.clipHtmlToMarkdown(`<html><head><title>T</title></head><body><nav>Home</nav><article><h1>T</h1>${para}<h2>Code</h2>${para}<pre><code class="language-python">print(1)\n</code></pre>${para}</article></body></html>`);
		assert.match(markdown, /```python\nprint\(1\)\n```/);
		assert.doesNotMatch(markdown, /Home/);
	});

	it("bare <pre> blocks (GitHub, Sphinx) become fenced code with their language", () => {
		assert.match(clip.clipHtmlToMarkdown('<div class="highlight highlight-source-python"><pre>import os\nprint(os.name)</pre></div>').markdown, /```python\nimport os\nprint\(os.name\)\n```/);
		assert.match(clip.clipHtmlToMarkdown('<div class="highlight-python3 notranslate"><div class="highlight"><pre><span class="gp">&gt;&gt;&gt; </span>1</pre></div></div>').markdown, /```python\n>>> 1\n```/);
		assert.match(clip.clipHtmlToMarkdown('<pre class="brush: js notranslate"><code>let x = 1;</code></pre>').markdown, /```js\nlet x = 1;\n```/);
		assert.doesNotMatch(clip.clipHtmlToMarkdown('<h2>Hi<span class="mw-editsection">[edit]</span><a class="headerlink" href="#hi">¶</a></h2>').markdown, /edit|¶/);
	});

	it("keeps code language from class names", () => {
		const { markdown } = clip.clipHtmlToMarkdown('<h2>Hi</h2><p>Text</p><pre><code class="language-cpp">int x = 1;\n</code></pre>');
		assert.match(markdown, /## Hi/);
		assert.match(markdown, /```cpp\nint x = 1;\n```/);
	});
});

describe("import_page_as_notebook (MCP)", () => {
	async function call(args: Record<string, unknown>) {
		const server = createGymMcpServer();
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await server.connect(serverSide);
		const client = new Client({ name: "test", version: "0" });
		await client.connect(clientSide);
		const r = (await client.callTool({ name: "import_page_as_notebook", arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
		return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
	}

	it("creates a private notebook and inserts exercises after their sections", async () => {
		clip.setClipExerciseWriterForTests(async () => '[{"section":1,"exercise":"Change the loop to count to 5."}]');
		try {
			const r = await call({ url: META.url, markdown: PAGE });
			assert.equal(r.isError, false, r.text);
			const info = JSON.parse(r.text.split("\n")[0]!) as { id: string; exercises: string; path: string };
			assert.equal(info.exercises, "queued");
			assert.equal(info.path, `/notebook/${info.id}`);
			// Background write: wait until the exercise lands.
			for (let i = 0; i < 50 && !stores.journalStore.getJournal(info.id)!.cells.some((c) => c.role === "exercise"); i++) {
				await new Promise((res) => setTimeout(res, 10));
			}
			const journal = stores.journalStore.getJournal(info.id)!;
			assert.equal(journal.title, "example.com", "markdown without a title falls back to the host");
			assert.deepEqual(journal.tags, ["clip"]);
			const roles = journal.cells.map((c) => c.role);
			assert.deepEqual(roles, ["aside", "aside", "aside", "code", "aside", "aside", "exercise", "aside"]);
			assert.ok(journal.cells.filter((c) => c.role !== "exercise").every((c) => !c.publish), "clipped cells are private");
			assert.equal(journal.cells.find((c) => c.role === "code")!.lang, "py");
		} finally {
			clip.setClipExerciseWriterForTests(null);
		}
	});

	it("a failed exercise call leaves a note in the notebook", async () => {
		clip.setClipExerciseWriterForTests(async () => "*(failed: not signed in)*");
		try {
			const r = await call({ url: META.url, markdown: PAGE });
			const { id } = JSON.parse(r.text.split("\n")[0]!) as { id: string };
			let last = "";
			for (let i = 0; i < 50 && !last.startsWith(clip.CLIP_EXERCISES_FAILED); i++) {
				await new Promise((res) => setTimeout(res, 10));
				last = stores.journalStore.getJournal(id)!.cells.at(-1)!.source;
			}
			assert.match(last, /^> Exercises could not be written: not signed in\./);
		} finally {
			clip.setClipExerciseWriterForTests(null);
		}
	});

	it("refuses a non-http url", async () => {
		const r = await call({ url: "file:///etc/passwd", markdown: "x" });
		assert.equal(r.isError, true);
	});
});
