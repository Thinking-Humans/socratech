/**
 * Notes vault (docs/notes-first.md N1): plain `.md` files in one folder the
 * learner owns — Obsidian / Emacs / git can open the same files. Every path
 * crossing this seam is vault-relative and resolved INSIDE the vault (no
 * "..", no absolute paths, no symlink escape); only `.md` files are served.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { stores } from "./stores.ts";

export class NoteError extends Error {
	constructor(
		message: string,
		readonly code: "invalid" | "not_found" | "conflict",
	) {
		super(message);
		this.name = "NoteError";
	}
}

export interface NoteFile {
	/** Vault-relative, "/"-separated ("daily/2026-11-15.md"). */
	path: string;
	content: string;
	/** mtime in ms — the optimistic-concurrency token for writes. */
	mtime: number;
}

export interface NoteSummary {
	path: string;
	mtime: number;
}

/** The vault root: Settings → Notes, else `<data>/notes`. Created on demand. */
export function vaultDir(): string {
	const dir = stores.settingsStore.readSettings()?.notes?.vaultDir ?? path.join(PATHS.data, "notes");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Local calendar date, YYYY-MM-DD. */
export function today(now: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function dailyNotePath(date: string = today()): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new NoteError("date must be YYYY-MM-DD", "invalid");
	return `daily/${date}.md`;
}

const SEGMENT_RE = /^[^/\\\0]+$/;

/** Vault-relative path → absolute path inside the vault, or NoteError. */
export function resolveNotePath(rel: string, root: string = vaultDir()): string {
	const clean = rel.replace(/\\/g, "/");
	const segments = clean.split("/");
	if (!clean.endsWith(".md") || segments.some((s) => !SEGMENT_RE.test(s) || s === "." || s === ".." || s.startsWith("."))) {
		throw new NoteError(`Invalid note path "${rel}".`, "invalid");
	}
	const abs = path.join(root, ...segments);
	// Symlink escape: the nearest existing ancestor must resolve inside the vault.
	const realRoot = fs.realpathSync(root);
	let probe = abs;
	while (!fs.existsSync(probe)) probe = path.dirname(probe);
	const real = fs.realpathSync(probe);
	if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new NoteError(`Note path "${rel}" leaves the vault.`, "invalid");
	return abs;
}

export function readNote(rel: string): NoteFile | null {
	const abs = resolveNotePath(rel);
	if (!fs.existsSync(abs)) return null;
	return { path: rel, content: fs.readFileSync(abs, "utf8"), mtime: fs.statSync(abs).mtimeMs };
}

/** The daily note for `date`, created with a heading when missing. */
export function ensureDailyNote(date: string = today()): NoteFile {
	const rel = dailyNotePath(date);
	return readNote(rel) ?? writeNote(rel, `# ${date}\n\n## `);
}

/**
 * Write a note. `ifMtime` = the mtime the editor loaded; when the file has
 * changed on disk since (another editor, Obsidian), the write is refused
 * so neither side silently loses text.
 */
export function writeNote(rel: string, content: string, ifMtime?: number): NoteFile {
	const abs = resolveNotePath(rel);
	if (ifMtime !== undefined && fs.existsSync(abs) && Math.abs(fs.statSync(abs).mtimeMs - ifMtime) > 1) {
		throw new NoteError("This note changed on disk since you loaded it — reload to see the other version.", "conflict");
	}
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	const tmp = `${abs}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, content, "utf8");
	fs.renameSync(tmp, abs);
	return { path: rel, content, mtime: fs.statSync(abs).mtimeMs };
}

/** Every `.md` in the vault (hidden dirs skipped), newest first. */
export function listNotes(root: string = vaultDir()): NoteSummary[] {
	const out: NoteSummary[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(abs, rel);
			else if (entry.isFile() && entry.name.endsWith(".md")) out.push({ path: rel, mtime: fs.statSync(abs).mtimeMs });
		}
	};
	walk(root, "");
	return out.sort((a, b) => b.mtime - a.mtime);
}

/** Run a route body; NoteError → 400/404/409, anything else → 500. */
export async function noteRoute(fn: () => Response | Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof NoteError) {
			const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400;
			return Response.json({ error: err.message, code: err.code }, { status });
		}
		if (err instanceof SyntaxError) return Response.json({ error: "Body must be JSON.", code: "invalid" }, { status: 400 });
		console.error("[notes] route failed:", err);
		return Response.json({ error: "Note operation failed." }, { status: 500 });
	}
}
