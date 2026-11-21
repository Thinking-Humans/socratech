/**
 * Journal publishing (learn-in-public phase 4): dry-run plan, write +
 * commit-only-the-bundle + push into a real temp git repo with a bare
 * remote, republish pinning (R5), unchanged republish, blockers.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-publish-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { stores, createJournal, addJournalCell, patchJournalMeta, planPublish, publishJournal, postUrl } = await import("../src/server/index.ts");
const { journalMediaDir } = await import("../src/server/journal-media.ts");
const publishRoute = await import("../app/api/journals/[id]/publish/route.ts");
const settingsRoute = await import("../app/api/settings/[section]/route.ts");

const SITE = path.join(TMP, "site");
const REMOTE = path.join(TMP, "remote.git");
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

before(() => {
	fs.mkdirSync(SITE, { recursive: true });
	sh(TMP, "init", "--quiet", "--bare", REMOTE);
	sh(SITE, "init", "--quiet", "-b", "main");
	sh(SITE, "config", "user.email", "test@example.com");
	sh(SITE, "config", "user.name", "Test");
	sh(SITE, "config", "commit.gpgsign", "false");
	fs.writeFileSync(path.join(SITE, "README.md"), "site\n");
	fs.writeFileSync(path.join(SITE, "other.txt"), "unrelated\n");
	sh(SITE, "add", "README.md");
	sh(SITE, "commit", "--quiet", "-m", "init");
	sh(SITE, "remote", "add", "origin", REMOTE);
	sh(SITE, "push", "--quiet", "-u", "origin", "main");
});

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

function setPublishing(p: Record<string, unknown> | undefined) {
	const record = stores.settingsStore.readSettings() ?? { version: 1 };
	stores.settingsStore.writeSettings({ ...record, ...(p ? { publishing: p } : { publishing: {} }) });
}

describe("publish plan", () => {
	it("blocks until publishing is set up, and when nothing is public", async () => {
		setPublishing(undefined);
		const j = createJournal({ title: "Blocked" });
		let plan = await planPublish(j.id);
		assert.match(plan.blockers.join(" "), /Settings → Publishing/);
		// …but still previews against the default content folder
		assert.match(plan.dir!, /^content\/posts\/\d{4}-\d{2}-\d{2}-blocked$/);
		assert.match(plan.files[0]!.content!, /title: "Blocked"/);
		setPublishing({ siteRepo: SITE, baseUrl: "https://me.github.io/blog" });
		addJournalCell(j.id, { role: "aside", source: "private only" });
		plan = await planPublish(j.id);
		assert.match(plan.blockers.join(" "), /No cell is set to publish/);
	});

	it("refuses a non-repo site path", async () => {
		setPublishing({ siteRepo: path.join(TMP, "nope") });
		const j = createJournal({ title: "Nowhere" });
		addJournalCell(j.id, { role: "reflection", source: "x" });
		assert.match((await planPublish(j.id)).blockers.join(" "), /not a git repository/);
		setPublishing({ siteRepo: SITE, baseUrl: "https://me.github.io/blog" });
	});

	it("postUrl maps content/<section>/<dir> to <base>/<section>/<dir>/", () => {
		assert.equal(postUrl("https://me.github.io/blog/", "content/posts/2026-11-15-x"), "https://me.github.io/blog/posts/2026-11-15-x/");
		assert.equal(postUrl(undefined, "content/posts/x"), undefined);
	});
});

describe("publish", () => {
	it("writes the bundle, commits ONLY it, pushes, records the publication", async () => {
		setPublishing({ siteRepo: SITE, baseUrl: "https://me.github.io/blog" });
		const j = createJournal({ title: "Spectral notes" });
		addJournalCell(j.id, { role: "reflection", source: "The Laplacian is PSD: $x^\\top L x \\ge 0$." });
		addJournalCell(j.id, { role: "aside", source: "private aside" });
		// Something unrelated already staged must NOT ride the journal commit.
		sh(SITE, "add", "other.txt");

		const plan = await planPublish(j.id);
		assert.deepEqual(plan.blockers, []);
		assert.match(plan.dir!, /^content\/posts\/\d{4}-\d{2}-\d{2}-spectral-notes$/);
		assert.deepEqual(plan.files.map((f) => [f.name, f.status]), [["index.md", "new"]]);
		assert.equal(plan.branch, "main");
		assert.equal(plan.remote, "origin");

		const res = await publishRoute.POST(
			new Request("http://test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmDir: plan.dir }) }),
			{ params: Promise.resolve({ id: j.id }) },
		);
		assert.equal(res.status, 200);
		const { result } = (await res.json()) as { result: { changed: boolean; pushed: boolean; commit: string; url: string } };
		assert.equal(result.changed, true);
		assert.equal(result.pushed, true);
		assert.equal(result.url, `https://me.github.io/blog/posts/${path.basename(plan.dir!)}/`);

		const md = fs.readFileSync(path.join(SITE, plan.dir!, "index.md"), "utf-8");
		assert.match(md, /title: "Spectral notes"/);
		assert.doesNotMatch(md, /private aside/);
		assert.deepEqual(sh(SITE, "show", "--name-only", "--format=", "HEAD").split("\n"), [`${plan.dir}/index.md`]);
		assert.equal(sh(SITE, "diff", "--cached", "--name-only"), "other.txt", "unrelated staged file stays staged, uncommitted");
		assert.equal(sh(REMOTE, "rev-parse", "main"), result.commit);

		const saved = stores.journalStore.getJournal(j.id)!;
		assert.equal(saved.publications.length, 1);
		assert.equal(saved.publications[0]!.path, plan.dir);
		sh(SITE, "reset", "--quiet", "other.txt");
	});

	it("republish pins the dir + date, adds lastmod, refuses slug edits; identical republish commits nothing", async () => {
		const j = createJournal({ title: "Pinned post" });
		const withCell = addJournalCell(j.id, { role: "reflection", source: "v1" });
		const first = await planPublish(j.id);
		await publishJournal(j.id, first.dir!);
		await assert.rejects(Promise.resolve().then(() => patchJournalMeta(j.id, { slug: "moved" })), /pinned/);

		// identical content → unchanged, no commit
		const head = sh(SITE, "rev-parse", "HEAD");
		const again = await planPublish(j.id);
		assert.equal(again.dir, first.dir);
		assert.equal(again.republish, true);
		assert.deepEqual(again.files.map((f) => f.status), ["unchanged"]);
		const r0 = await publishJournal(j.id, again.dir!);
		assert.equal(r0.changed, false);
		assert.equal(sh(SITE, "rev-parse", "HEAD"), head);

		// retitle → changed, same dir, original date kept, lastmod added
		patchJournalMeta(j.id, { title: "Pinned post, revised" });
		const changed = await planPublish(j.id);
		assert.equal(changed.dir, first.dir);
		assert.deepEqual(changed.files.map((f) => f.status), ["changed"]);
		await publishJournal(j.id, changed.dir!);
		const md = fs.readFileSync(path.join(SITE, first.dir!, "index.md"), "utf-8");
		assert.match(md, new RegExp(`date: ${path.basename(first.dir!).slice(0, 10)}\\nlastmod: \\d{4}-\\d{2}-\\d{2}\\n`));
		assert.match(md, /Pinned post, revised/);
		// the unchanged republish recorded nothing
		assert.equal(stores.journalStore.getJournal(withCell.id)!.publications.length, 2);
	});

	it("format switch to notebook writes the ipynb, the marimo .py and front-matter-only index.md", async () => {
		setPublishing({ siteRepo: SITE, format: "notebook", push: false });
		const j = createJournal({ title: "Notebook post" });
		addJournalCell(j.id, { role: "code", lang: "python", source: "print(1)", output: "1" });
		const plan = await planPublish(j.id);
		assert.deepEqual(plan.files.map((f) => [f.name, f.status]).sort(), [["index.md", "new"], ["notebook.ipynb", "new"], ["notebook.py", "new"]]);
		assert.equal(plan.remote, null);
		const r = await publishJournal(j.id, plan.dir!);
		assert.equal(r.pushed, false);
		const nb = JSON.parse(fs.readFileSync(path.join(SITE, plan.dir!, "notebook.ipynb"), "utf-8"));
		assert.equal(nb.cells[0].cell_type, "code");
		const marimo = fs.readFileSync(path.join(SITE, plan.dir!, "notebook.py"), "utf-8");
		assert.match(marimo, /^import marimo\n/);
		assert.match(marimo, /\n {4}print\(1\)\n/);
		assert.equal(fs.existsSync(path.join(SITE, plan.dir!, "notebook.socratech.json")), false, "the sidecar never ships");
		setPublishing({ siteRepo: SITE, baseUrl: "https://me.github.io/blog" });
	});

	it("blocks a dirty bundle dir and a moved target", async () => {
		const j = createJournal({ title: "Dirty dir" });
		addJournalCell(j.id, { role: "reflection", source: "v1" });
		const plan = await planPublish(j.id);
		await publishJournal(j.id, plan.dir!);
		fs.writeFileSync(path.join(SITE, plan.dir!, "index.md"), "hand edit\n");
		assert.match((await planPublish(j.id)).blockers.join(" "), /uncommitted changes/);
		sh(SITE, "checkout", "--quiet", "--", plan.dir!);

		const k = createJournal({ title: "Moved target" });
		addJournalCell(k.id, { role: "reflection", source: "v1" });
		await assert.rejects(publishJournal(k.id, "content/posts/somewhere-else"), /moved/);
	});
});

describe("Hugo site config for interactive visuals (media/*.html)", () => {
	/** A fresh site repo holding `files`, committed; publishing points at it (no push). */
	function hugoSite(name: string, files: Record<string, string>): string {
		const site = path.join(TMP, name);
		fs.mkdirSync(site, { recursive: true });
		sh(site, "init", "--quiet", "-b", "main");
		sh(site, "config", "user.email", "test@example.com");
		sh(site, "config", "user.name", "Test");
		sh(site, "config", "commit.gpgsign", "false");
		for (const [f, c] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(site, f)), { recursive: true });
			fs.writeFileSync(path.join(site, f), c);
		}
		sh(site, "add", "-A");
		sh(site, "commit", "--quiet", "-m", "init");
		setPublishing({ siteRepo: site, push: false });
		return site;
	}

	/** A journal whose published cell embeds `media`, stored as the visuals pipeline stores it. */
	function journalWith(title: string, media: string) {
		const j = createJournal({ title });
		fs.mkdirSync(journalMediaDir(j.id), { recursive: true });
		fs.writeFileSync(path.join(journalMediaDir(j.id), media), "<!doctype html><html><body>viz</body></html>");
		addJournalCell(j.id, { role: "reflection", source: `See it:\n\n![viz](media/${media})` });
		return j;
	}

	after(() => setPublishing({ siteRepo: SITE, baseUrl: "https://me.github.io/blog" }));

	it("patches hugo.toml with the mounts and commits it together with the bundle", async () => {
		const site = hugoSite("hugo-toml", { "hugo.toml": 'title = "x"\n' });
		const j = journalWith("Viz post", "viz-abc123.html");
		const plan = await planPublish(j.id);
		assert.deepEqual(plan.blockers, []);
		assert.equal(plan.siteConfig?.name, "hugo.toml");
		assert.match(plan.siteConfig!.content, /^title = "x"\n\n# Socratech/);
		assert.match(plan.siteConfig!.content, /files = \["\*\*\/media\/\*\.html"\]/);

		await publishJournal(j.id, plan.dir!);
		assert.deepEqual(sh(site, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), [`${plan.dir}/index.md`, `${plan.dir}/media/viz-abc123.html`, "hugo.toml"]);
		assert.match(fs.readFileSync(path.join(site, "hugo.toml"), "utf-8"), /\[\[module\.mounts\]\]/);

		// already configured → no patch on the next publish
		const k = journalWith("Viz post two", "viz-def456.html");
		assert.equal((await planPublish(k.id)).siteConfig, undefined);
	});

	it("leaves non-Hugo sites and journals without visuals alone", async () => {
		hugoSite("plain", { "README.md": "x\n" });
		const j = journalWith("No hugo", "viz-aaa111.html");
		const plan = await planPublish(j.id);
		assert.deepEqual(plan.blockers, []);
		assert.equal(plan.siteConfig, undefined);

		hugoSite("hugo-no-viz", { "hugo.toml": 'title = "x"\n' });
		const k = createJournal({ title: "Text only" });
		addJournalCell(k.id, { role: "reflection", source: "words" });
		assert.equal((await planPublish(k.id)).siteConfig, undefined);
	});

	it("blocks with the snippet when the config can't be patched safely", async () => {
		const cases: [string, Record<string, string>, RegExp][] = [
			["hugo-yaml", { "hugo.yaml": "title: x\n" }, /isn't TOML/],
			["hugo-module", { "hugo.toml": '[module]\n  [[module.imports]]\n    path = "theme"\n' }, /already has a \[module\]/],
			["hugo-dir", { "config/_default/hugo.toml": 'title = "x"\n' }, /config\/_default/],
		];
		for (const [name, files, why] of cases) {
			hugoSite(name, files);
			const j = journalWith(`Blocked ${name}`, "viz-bbb222.html");
			const plan = await planPublish(j.id);
			const msg = plan.blockers.join(" ");
			assert.match(msg, why, name);
			assert.match(msg, /\[\[module\.mounts\]\]/, name);
			assert.equal(plan.siteConfig, undefined, name);
		}
	});

	it("blocks a hugo.toml with uncommitted changes", async () => {
		const site = hugoSite("hugo-dirty", { "hugo.toml": 'title = "x"\n' });
		fs.appendFileSync(path.join(site, "hugo.toml"), "# wip\n");
		const j = journalWith("Dirty config", "viz-ccc333.html");
		assert.match((await planPublish(j.id)).blockers.join(" "), /hugo\.toml has uncommitted changes/);
	});
});

describe("publish → graph (D7)", () => {
	it("reports the graph-import outcome (test env never runs extraction)", async () => {
		const j = createJournal({ title: "Graph outcome" });
		addJournalCell(j.id, { role: "reflection", source: "x" });
		const plan = await planPublish(j.id);
		const r = await publishJournal(j.id, plan.dir!);
		assert.equal(r.graphImport, "test");
		const again = await publishJournal(j.id, (await planPublish(j.id)).dir!);
		assert.equal(again.graphImport, "unchanged");
	});
});

describe("cross-site guard (browser-only mode answers any caller)", () => {
	const post = (headers: Record<string, string>, body: unknown) =>
		new Request("http://localhost:3000/api/x", { method: "POST", headers: { host: "localhost:3000", ...headers }, body: JSON.stringify(body) });

	it("publish POST refuses text/plain (no preflight) and foreign origins", async () => {
		const j = createJournal({ title: "Guarded" });
		const ctx = { params: Promise.resolve({ id: j.id }) };
		assert.equal((await publishRoute.POST(post({ "content-type": "text/plain" }, { confirmDir: "x" }), ctx)).status, 415);
		assert.equal((await publishRoute.POST(post({ "content-type": "application/json", origin: "https://evil.example" }, { confirmDir: "x" }), ctx)).status, 403);
		// same origin passes the guard (then fails on the moved target → 409)
		assert.equal((await publishRoute.POST(post({ "content-type": "application/json", origin: "http://localhost:3000" }, { confirmDir: "x" }), ctx)).status, 400);
	});

	it("publishing settings PUT is guarded; other sections are untouched", async () => {
		const put = (section: string, headers: Record<string, string>, body: unknown) =>
			settingsRoute.PUT(
				new Request(`http://localhost:3000/api/settings/${section}`, { method: "PUT", headers: { host: "localhost:3000", ...headers }, body: JSON.stringify(body) }),
				{ params: Promise.resolve({ section }) },
			);
		assert.equal((await put("publishing", { "content-type": "text/plain" }, { siteRepo: "/evil" })).status, 415);
		assert.equal((await put("publishing", { "content-type": "application/json", origin: "https://evil.example" }, { siteRepo: "/evil" })).status, 403);
		assert.equal((await put("publishing", { "content-type": "application/json" }, { siteRepo: SITE, baseUrl: "https://me.github.io/blog" })).status, 200);
	});
});
