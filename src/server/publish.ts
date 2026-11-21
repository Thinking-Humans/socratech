/**
 * Publish a journal to the learner's site repo (learn-in-public phase 4,
 * docs/learn-in-public.md D10 + R5). Two steps, both server-side:
 *
 *   planPublish(id)     dry run — what would be written where, file by file
 *                       (new / changed / unchanged / removed), the commit
 *                       message, the push target, and any blockers. Writes
 *                       nothing. The UI shows this for confirmation.
 *   publishJournal(id)  write the bundle into <siteRepo>/<dir>, stage ONLY
 *                       that directory, commit ONLY that directory, push
 *                       (setting), record the publication, then feed the
 *                       published reflections to the graph (D7).
 *
 * The confirm carries the planned dir: if the plan moved between preview
 * and confirm (slug edit, setting change) the publish refuses rather than
 * write somewhere the learner did not see.
 *
 * Git runs as the user's own `git` with their credentials (ssh agent /
 * credential helper); GIT_TERMINAL_PROMPT=0 so a missing credential fails
 * fast instead of hanging the request on a hidden prompt.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
	GraphImportOutcome,
	Journal,
	JournalPublication,
	PlannedFileStatus,
	PublishPlan,
	PublishResult,
	PublishTarget,
} from "../core/contracts/journal.ts";
import { exportJournal, publishedCells, publishedMediaNames, type JournalBundle } from "../core/journal-export.ts";
import { MEDIA_DIR, isVisualName } from "../core/journal-media.ts";
import { journalMediaFile } from "./journal-media.ts";
import { hugoHtmlMediaFix } from "./site-config.ts";
import { extractPublishedNotebook } from "./notebook-learning.ts";
import { JournalError } from "../core/journal.ts";
import { getGraph } from "../core/graph.ts";
import { stores } from "./stores.ts";

const run = promisify(execFile);

/** Files the exporter can produce — the only names publish ever removes. */
const BUNDLE_FILES = ["index.md", "notebook.ipynb", "notebook.py"] as const;

/** Settings → concrete target, or null when publishing is not set up. */
export function resolvePublishTarget(): PublishTarget | null {
	const p = stores.settingsStore.readSettings()?.publishing;
	if (!p?.siteRepo) return null;
	return {
		siteRepo: p.siteRepo,
		contentDir: p.contentDir ?? "content/posts",
		format: p.format ?? "markdown",
		...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
		push: p.push ?? true,
	};
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await run("git", args, {
		cwd,
		timeout: 60_000,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		maxBuffer: 4 * 1024 * 1024,
	});
	return stdout.trim();
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
	try {
		return await git(cwd, args);
	} catch {
		return null;
	}
}

function today(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The first publication into this repo — its dir is pinned (R5). */
function pinnedPublication(journal: Journal, siteRepo: string): JournalPublication | undefined {
	return journal.publications.find((p) => p.siteRepo === siteRepo);
}

/** Post URL: <baseUrl>/<path below "content/">/ (Hugo's section permalink). */
export function postUrl(baseUrl: string | undefined, dir: string): string | undefined {
	if (!baseUrl) return undefined;
	const rel = dir.startsWith("content/") ? dir.slice("content/".length) : dir;
	return `${baseUrl.replace(/\/+$/, "")}/${rel}/`;
}

function ideaNames(): Record<string, string> {
	const names: Record<string, string> = {};
	for (const n of getGraph(stores.graphStore).nodes) names[n.id] = n.name;
	return names;
}

function buildBundle(journal: Journal, target: PublishTarget): { bundle: JournalBundle; dir: string; republish: boolean } {
	const pinned = pinnedPublication(journal, target.siteRepo);
	if (pinned) {
		const dirName = path.posix.basename(pinned.path);
		const bundle = exportJournal(journal, {
			date: dirName.slice(0, 10),
			lastmod: today(),
			dirName,
			format: target.format,
			ideaNames: ideaNames(),
		});
		return { bundle, dir: pinned.path, republish: true };
	}
	const bundle = exportJournal(journal, { date: today(), format: target.format, ideaNames: ideaNames() });
	return { bundle, dir: path.posix.join(target.contentDir, bundle.dir), republish: false };
}

function readIfExists(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
}

/** Strip a volatile `lastmod:` line so an otherwise-identical republish
 *  reads as unchanged (today's date alone is not a change). */
const withoutLastmod = (s: string) => s.replace(/^lastmod: .*\n/m, "");

export async function planPublish(journalId: string): Promise<PublishPlan> {
	const journal = stores.journalStore.getJournal(journalId);
	if (!journal) throw new JournalError(`No journal [${journalId}].`, "not_found");
	const target = resolvePublishTarget();
	const commitMessage = `journal: ${journal.title}\n\nPublished from Socratech journal ${journal.id}.`;
	const plan: PublishPlan = {
		journalId,
		target,
		dir: null,
		files: [],
		republish: false,
		branch: null,
		remote: null,
		commitMessage,
		blockers: [],
	};
	if (!target) {
		plan.blockers.push("Publishing is not set up — choose a site repo in Settings → Publishing.");
		// Still preview: the bundle against the default content folder.
		const bundle = exportJournal(journal, { date: today(), format: "markdown", ideaNames: ideaNames() });
		plan.dir = path.posix.join("content/posts", bundle.dir);
		plan.files = Object.entries(bundle.files).map(([name, content]) => ({ name, status: "new" as const, content }));
		for (const name of publishedMediaNames(journal)) plan.files.push({ name: `${MEDIA_DIR}/${name}`, status: "new" });
		return plan;
	}

	const { bundle, dir, republish } = buildBundle(journal, target);
	plan.dir = dir;
	plan.republish = republish;
	const url = postUrl(target.baseUrl, dir);
	if (url) plan.url = url;
	if (publishedCells(journal).length === 0) plan.blockers.push("No cell is set to publish — toggle a cell's eye first.");

	const top = await tryGit(target.siteRepo, ["rev-parse", "--show-toplevel"]);
	if (top === null) {
		plan.blockers.push(`${target.siteRepo} is not a git repository.`);
		return plan;
	}

	const abs = path.join(target.siteRepo, dir);
	for (const name of BUNDLE_FILES) {
		const content = bundle.files[name];
		const onDisk = readIfExists(path.join(abs, name));
		if (content === undefined) {
			if (onDisk !== null) plan.files.push({ name, status: "removed" });
			continue;
		}
		const status: PlannedFileStatus =
			onDisk === null ? "new" : withoutLastmod(onDisk) === withoutLastmod(content) ? "unchanged" : "changed";
		plan.files.push({ name, status, content });
	}

	// Embedded images / videos (journal-media): copied into <bundle>/media/.
	// Stored names carry a unique tag, so a same-size file is the same file.
	const media = publishedMediaNames(journal);
	for (const name of media) {
		const src = journalMediaFile(journalId, name);
		if (!src) {
			plan.blockers.push(`A cell embeds ${MEDIA_DIR}/${name}, but that file is missing from this journal.`);
			continue;
		}
		const dest = path.join(abs, MEDIA_DIR, name);
		const status: PlannedFileStatus = !fs.existsSync(dest) ? "new" : fs.statSync(dest).size === fs.statSync(src).size ? "unchanged" : "changed";
		plan.files.push({ name: `${MEDIA_DIR}/${name}`, status });
	}
	let onDiskMedia: string[] = [];
	try {
		onDiskMedia = fs.readdirSync(path.join(abs, MEDIA_DIR));
	} catch {
		/* no media folder yet */
	}
	for (const name of onDiskMedia) if (!media.includes(name)) plan.files.push({ name: `${MEDIA_DIR}/${name}`, status: "removed" });

	// Interactive visuals (media/*.html) break Hugo builds unless the site
	// serves them as static files (site-config.ts): patch its config, or block.
	if (media.some(isVisualName)) {
		const fix = hugoHtmlMediaFix(target.siteRepo);
		if (fix.kind === "blocker") plan.blockers.push(fix.message);
		else if (fix.kind === "patch") {
			plan.siteConfig = { name: fix.name, status: "changed", content: fix.content };
			const dirtyConfig = await tryGit(target.siteRepo, ["status", "--porcelain", "--", fix.name]);
			if (dirtyConfig) plan.blockers.push(`${fix.name} has uncommitted changes in the site repo — commit or discard them first.`);
		}
	}

	const dirty = await tryGit(target.siteRepo, ["status", "--porcelain", "--", dir]);
	if (dirty) plan.blockers.push(`${dir} has uncommitted changes in the site repo — commit or discard them first.`);

	plan.branch = await tryGit(target.siteRepo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (target.push) {
		if (!plan.branch) plan.blockers.push("The site repo is on a detached HEAD — check out a branch to push.");
		else {
			const upstream = await tryGit(target.siteRepo, ["config", `branch.${plan.branch}.remote`]);
			const remotes = ((await tryGit(target.siteRepo, ["remote"])) ?? "").split("\n").filter(Boolean);
			plan.remote = upstream ?? (remotes.includes("origin") ? "origin" : (remotes[0] ?? null));
			if (!plan.remote) plan.blockers.push("The site repo has no remote to push to — add one, or turn push off.");
		}
	}
	return plan;
}

const inFlight = new Set<string>();

export async function publishJournal(journalId: string, confirmDir: string): Promise<PublishResult> {
	if (inFlight.has(journalId)) throw new JournalError("This journal is already publishing.", "conflict");
	inFlight.add(journalId);
	try {
		const plan = await planPublish(journalId);
		if (plan.blockers.length > 0) throw new JournalError(plan.blockers.join(" "), "invalid");
		const target = plan.target!;
		const dir = plan.dir!;
		if (dir !== confirmDir) {
			throw new JournalError(`The publish target moved to ${dir} since you previewed it — review and confirm again.`, "conflict");
		}

		const abs = path.join(target.siteRepo, dir);
		fs.mkdirSync(abs, { recursive: true });
		for (const f of plan.files) {
			if (f.status === "removed") fs.rmSync(path.join(abs, f.name), { force: true });
			// Unchanged files stay untouched: rewriting them would commit a
			// lastmod-only diff.
			else if (f.status !== "unchanged" && f.content !== undefined) fs.writeFileSync(path.join(abs, f.name), f.content, "utf-8");
			else if (f.status !== "unchanged" && f.name.startsWith(`${MEDIA_DIR}/`)) {
				const src = journalMediaFile(journalId, f.name.slice(MEDIA_DIR.length + 1));
				if (!src) throw new JournalError(`${f.name} disappeared before publishing.`, "conflict");
				fs.mkdirSync(path.join(abs, MEDIA_DIR), { recursive: true });
				fs.copyFileSync(src, path.join(abs, f.name));
			}
		}

		// The site config patch (if any) rides in the same commit as the bundle.
		const paths = [dir];
		if (plan.siteConfig) {
			fs.writeFileSync(path.join(target.siteRepo, plan.siteConfig.name), plan.siteConfig.content, "utf-8");
			paths.push(plan.siteConfig.name);
		}

		await git(target.siteRepo, ["add", "-A", "--", ...paths]);
		const staged = await git(target.siteRepo, ["diff", "--cached", "--name-only", "--", ...paths]);
		let commit: string | undefined;
		let pushed = false;
		if (staged) {
			// `commit -- <paths>` commits ONLY the bundle (+ config patch), whatever else is staged.
			await git(target.siteRepo, ["commit", "--quiet", "-m", plan.commitMessage, "--", ...paths]);
			commit = await git(target.siteRepo, ["rev-parse", "HEAD"]);
			if (target.push && plan.remote && plan.branch) {
				await git(target.siteRepo, ["push", "--quiet", plan.remote, `HEAD:${plan.branch}`]);
				pushed = true;
			}
		}

		const fresh = stores.journalStore.getJournal(journalId);
		if (!fresh) throw new JournalError(`No journal [${journalId}].`, "not_found");
		// Nothing staged = nothing published: no record, no graph feed.
		if (!staged) return { journal: fresh, dir, changed: false, pushed: false, ...(plan.url ? { url: plan.url } : {}), graphImport: "unchanged" };

		const at = new Date().toISOString();
		const publication: JournalPublication = {
			at,
			siteRepo: target.siteRepo,
			path: dir,
			...(plan.url ? { url: plan.url } : {}),
			...(commit ? { commit } : {}),
		};
		const journal = stores.journalStore.saveJournal({ ...fresh, publications: [...fresh.publications, publication], updatedAt: at });

		// Every published cell that is new or edited since its last extraction
		// (notebook-learning.ts: one graph source per cell; edits replace).
		const graphImport = extractPublishedNotebook(journal);
		return { journal, dir, changed: true, ...(commit ? { commit } : {}), pushed, ...(plan.url ? { url: plan.url } : {}), graphImport };
	} finally {
		inFlight.delete(journalId);
	}
}

/**
 * Cross-site guard for the two routes that can make the app push with the
 * learner's git credentials (publish POST, publishing settings PUT). The
 * desktop shell already requires its per-launch header; browser-only mode
 * (`npm run dev`) answers any caller, and a "simple" cross-site POST
 * (text/plain) skips the CORS preflight. Requiring application/json forces
 * the preflight (which nothing here answers), and a present Origin must be
 * this host. Returns a refusal Response, or null to proceed.
 */
export function refuseCrossSite(req: Request): Response | null {
	const type = req.headers.get("content-type") ?? "";
	if (!type.toLowerCase().startsWith("application/json")) {
		return Response.json({ error: "Content-Type must be application/json.", code: "invalid" }, { status: 415 });
	}
	const origin = req.headers.get("origin");
	const host = req.headers.get("host");
	if (origin && host) {
		let originHost: string | null = null;
		try {
			originHost = new URL(origin).host;
		} catch {
			originHost = null;
		}
		if (originHost !== host) return Response.json({ error: "Cross-origin request refused.", code: "forbidden" }, { status: 403 });
	}
	return null;
}
