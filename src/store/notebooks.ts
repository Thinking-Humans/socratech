/**
 * JournalStore over marimo notebooks (docs/learn-in-public.md "Marimo
 * storage"). Implements core/ports.ts JournalStore.
 *
 * Files, in data/notebooks/ (PATHS.notebooks), named by journal id:
 *
 *   <id>.py              the marimo notebook — all readable text
 *   <id>.socratech.json  the sidecar — metadata marimo has no slot for
 *   _opted-out.json      chatId → deletedAt: sessions whose notebook the
 *                        learner deleted (auto-fill skips them)
 *
 * Id-based names: a title or slug change never renames a file, and git
 * history follows the notebook. The translation is pure
 * (core/marimo-format.ts); this adapter only reads, writes and heals.
 *
 * Writes are atomic per file (temp + fsync + rename), the .py first: a
 * crash between the two leaves the newer text with older metadata, which
 * the reader reconciles (cells matched by id, edited text detected by hash).
 *
 * Hand edits (the .py opened in marimo): reading reconciles the two files.
 * When that changes ids (a cell added in marimo, a copied cell) the .py is
 * rewritten so the ids stay stable; when only metadata changes (edited
 * text, a deleted cell) only the sidecar is rewritten. Pure formatting
 * differences (marimo's own signatures and blank lines) write nothing.
 *
 * Migration: the first store call in a process moves legacy
 * data/journals/<id>.json files into this format and the JSON files into
 * data/journals/.migrated/ (never deleted). Idempotent.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import { summarizeJournal } from "../core/journal.ts";
import { journalToMarimo, readMarimoNotebook } from "../core/marimo-format.ts";
import type { JournalStore } from "../core/ports.ts";
import type { Journal, JournalSummary } from "../core/contracts/journal.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

const ID_RE = /^[A-Za-z0-9_-]+$/;
const PY = ".py";
const SIDECAR = ".socratech.json";
const TOMBSTONE_NAME = "_opted-out.json";

const dir = () => PATHS.notebooks;
const TOMBSTONES = () => path.join(dir(), TOMBSTONE_NAME);

function checkId(id: string): string {
	if (!ID_RE.test(id)) throw new Error(`Invalid journal id: ${id}`);
	return id;
}
export const notebookPyFile = (id: string) => path.join(dir(), `${checkId(id)}${PY}`);
export const notebookSidecarFile = (id: string) => path.join(dir(), `${checkId(id)}${SIDECAR}`);

const sidecarText = (sidecar: unknown) => `${JSON.stringify(sidecar, null, "\t")}\n`;

function writeNotebook(journal: Journal): void {
	const { py, sidecar } = journalToMarimo(journal);
	fs.mkdirSync(dir(), { recursive: true });
	writeFileAtomicSync(notebookPyFile(journal.id), py);
	writeFileAtomicSync(notebookSidecarFile(journal.id), sidecarText(sidecar));
}

// ─── migration from data/journals/<id>.json ─────────────────────────────────

let migratedFrom: string | null = null;

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return undefined;
	}
}

/**
 * Move every legacy `data/journals/<id>.json` into the notebook format,
 * then the JSON into `data/journals/.migrated/`. A journal whose .py and
 * sidecar both exist already (an interrupted earlier run) is only moved. Unreadable
 * files stay where they are. The legacy opt-out list merges into the new
 * one and moves too. Safe to call again: nothing left means nothing done.
 */
export function migrateLegacyJournals(): { migrated: string[]; skipped: string[] } {
	const legacy = PATHS.journals;
	const backup = path.join(legacy, ".migrated");
	const migrated: string[] = [];
	const skipped: string[] = [];
	let names: string[];
	try {
		names = fs.readdirSync(legacy);
	} catch {
		return { migrated, skipped };
	}
	const moveToBackup = (name: string) => {
		fs.mkdirSync(backup, { recursive: true });
		let dest = path.join(backup, name);
		if (fs.existsSync(dest)) dest = path.join(backup, `${name.slice(0, -5)}.${Date.now()}.json`);
		fs.renameSync(path.join(legacy, name), dest);
	};
	for (const name of names) {
		if (!name.endsWith(".json") || name === TOMBSTONE_NAME) continue;
		const id = name.slice(0, -5);
		if (!ID_RE.test(id)) continue;
		try {
			// Both files = an earlier run finished this one. A lone .py (a crash
			// before the sidecar landed) is written again from the JSON.
			if (!fs.existsSync(notebookPyFile(id)) || !fs.existsSync(notebookSidecarFile(id))) {
				const journal = readJson(path.join(legacy, name)) as Journal | undefined;
				if (!journal || typeof journal !== "object" || !Array.isArray(journal.cells)) {
					console.warn(`[notebooks] left ${name} in place: not a readable journal`);
					skipped.push(id);
					continue;
				}
				writeNotebook({ ...journal, id });
			}
			moveToBackup(name);
			migrated.push(id);
		} catch (err) {
			console.warn(`[notebooks] could not migrate ${name}:`, err);
			skipped.push(id);
		}
	}
	if (names.includes(TOMBSTONE_NAME)) {
		const old = readJson(path.join(legacy, TOMBSTONE_NAME));
		if (old && typeof old === "object") {
			writeTombstones({ ...(old as Record<string, string>), ...readTombstones() });
			moveToBackup(TOMBSTONE_NAME);
		}
	}
	return { migrated, skipped };
}

/** Migrate once per process (per data dir). */
function ready(): void {
	if (migratedFrom === PATHS.journals) return;
	migratedFrom = PATHS.journals;
	const { migrated } = migrateLegacyJournals();
	if (migrated.length) console.info(`[notebooks] migrated ${migrated.length} journal(s) to ${dir()}`);
}

// ─── tombstones ─────────────────────────────────────────────────────────────

function readTombstones(): Record<string, string> {
	const map = readJson(TOMBSTONES());
	return map && typeof map === "object" ? (map as Record<string, string>) : {};
}

function writeTombstones(map: Record<string, string>): void {
	fs.mkdirSync(dir(), { recursive: true });
	writeFileAtomicSync(TOMBSTONES(), JSON.stringify(map, null, "\t"));
}

function isChatOptedOut(chatId: string): boolean {
	ready();
	return chatId in readTombstones();
}

function clearChatOptOut(chatId: string): void {
	ready();
	const map = readTombstones();
	if (!(chatId in map)) return;
	delete map[chatId];
	writeTombstones(map);
}

// ─── reads ──────────────────────────────────────────────────────────────────

function announce(journal: Pick<Journal, "id" | "chatId">): void {
	emit("journals-changed", { journalId: journal.id, ...(journal.chatId !== undefined ? { chatId: journal.chatId } : {}) });
}

function loadNotebook(id: string): Journal | null {
	let py: string;
	let mtime: string;
	try {
		const file = notebookPyFile(id);
		py = fs.readFileSync(file, "utf-8");
		mtime = fs.statSync(file).mtime.toISOString();
	} catch {
		return null;
	}
	if (!py.includes("marimo.App(")) return null;
	let sidecarRaw: string | null = null;
	try {
		sidecarRaw = fs.readFileSync(notebookSidecarFile(id), "utf-8");
	} catch {
		// a notebook made in marimo: defaults, then the sidecar is written below
	}
	let sidecar: unknown = null;
	let sidecarBroken = false;
	try {
		sidecar = sidecarRaw === null ? null : JSON.parse(sidecarRaw);
	} catch {
		sidecarBroken = true; // left as is for the learner to fix; nothing is written over it
		console.warn(`[notebooks] ${id}${SIDECAR} is not valid JSON; reading the notebook without it`);
	}
	const { journal, idsChanged } = readMarimoNotebook(py, sidecar, { id, now: mtime });
	// Heal: keep ids stable and the sidecar in step with hand edits.
	if (sidecarBroken) return journal;
	try {
		const fresh = journalToMarimo(journal);
		if (idsChanged) writeNotebook(journal);
		else if (sidecarText(fresh.sidecar) !== sidecarRaw) writeFileAtomicSync(notebookSidecarFile(id), sidecarText(fresh.sidecar));
	} catch (err) {
		console.warn(`[notebooks] could not write back ${id} after reading hand edits:`, err);
	}
	return journal;
}

function getJournal(id: string): Journal | null {
	if (!ID_RE.test(id)) return null;
	ready();
	return loadNotebook(id);
}

function readAll(): Journal[] {
	ready();
	let names: string[];
	try {
		names = fs.readdirSync(dir());
	} catch {
		return [];
	}
	return names
		.filter((f) => f.endsWith(PY) && ID_RE.test(f.slice(0, -PY.length)))
		.map((f) => loadNotebook(f.slice(0, -PY.length)))
		.filter((j): j is Journal => j !== null);
}

// ─── writes ─────────────────────────────────────────────────────────────────

function createJournal(journal: Journal): Journal {
	ready();
	if (fs.existsSync(notebookPyFile(journal.id))) throw new Error(`Journal ${journal.id} already exists`);
	writeNotebook(journal);
	announce(journal);
	return journal;
}

function saveJournal(journal: Journal): Journal {
	ready();
	if (!fs.existsSync(notebookPyFile(journal.id))) throw new Error(`Unknown journal ${journal.id}`);
	writeNotebook(journal);
	announce(journal);
	return journal;
}

function deleteJournal(id: string): boolean {
	if (!ID_RE.test(id)) return false;
	ready();
	const prev = loadNotebook(id);
	const py = notebookPyFile(id);
	const side = notebookSidecarFile(id);
	try {
		fs.unlinkSync(py);
	} catch {
		return false;
	}
	try {
		fs.unlinkSync(side);
	} catch {
		// already gone
	}
	removeLeftoverTemps(py);
	removeLeftoverTemps(side);
	if (prev?.chatId) writeTombstones({ ...readTombstones(), [prev.chatId]: new Date().toISOString() });
	announce(prev ?? { id });
	return true;
}

function findJournalByChat(chatId: string): Journal | null {
	return readAll().find((j) => j.chatId === chatId) ?? null;
}

function listJournals(): JournalSummary[] {
	return readAll()
		.map(summarizeJournal)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const notebookStore: JournalStore = {
	createJournal,
	getJournal,
	findJournalByChat,
	listJournals,
	saveJournal,
	deleteJournal,
	isChatOptedOut,
	clearChatOptOut,
};
