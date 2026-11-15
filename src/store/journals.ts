/**
 * JournalStore — the fs JSON adapter: one file per learn-in-public journal
 * in data/journals/ (core/contracts/journal.ts). Implements core/ports.ts
 * JournalStore. Same idioms as store/jobs.ts: sync fs, id-guarded filenames,
 * tab-indented JSON. Writes go through a temp file + rename so a torn write
 * never replaces a journal the learner has been writing in.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import { summarizeJournal } from "../core/journal.ts";
import type { JournalStore } from "../core/ports.ts";
import type { Journal, JournalSummary } from "../core/contracts/journal.ts";

/** chatId → deletedAt: sessions whose journal the learner deleted. */
const TOMBSTONES = () => path.join(PATHS.journals, "_opted-out.json");

function readTombstones(): Record<string, string> {
	try {
		return JSON.parse(fs.readFileSync(TOMBSTONES(), "utf-8")) as Record<string, string>;
	} catch {
		return {};
	}
}

function writeTombstones(map: Record<string, string>): void {
	fs.mkdirSync(PATHS.journals, { recursive: true });
	const tmp = `${TOMBSTONES()}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(map, null, "\t"), "utf-8");
	fs.renameSync(tmp, TOMBSTONES());
}

function isChatOptedOut(chatId: string): boolean {
	return chatId in readTombstones();
}

function clearChatOptOut(chatId: string): void {
	const map = readTombstones();
	if (!(chatId in map)) return;
	delete map[chatId];
	writeTombstones(map);
}

function journalFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid journal id: ${id}`);
	return path.join(PATHS.journals, `${id}.json`);
}

function writeAtomic(file: string, journal: Journal): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(journal, null, "\t"), "utf-8");
	fs.renameSync(tmp, file);
}

function announce(journal: Pick<Journal, "id" | "chatId">): void {
	emit("journals-changed", { journalId: journal.id, ...(journal.chatId !== undefined ? { chatId: journal.chatId } : {}) });
}

function getJournal(id: string): Journal | null {
	try {
		return JSON.parse(fs.readFileSync(journalFile(id), "utf-8")) as Journal;
	} catch {
		return null;
	}
}

function readAll(): Journal[] {
	try {
		return fs
			.readdirSync(PATHS.journals)
			.filter((f) => f.startsWith("jrnl_") && f.endsWith(".json"))
			.map((f) => getJournal(f.slice(0, -5)))
			.filter((j): j is Journal => j !== null);
	} catch {
		return [];
	}
}

function createJournal(journal: Journal): Journal {
	const file = journalFile(journal.id);
	if (fs.existsSync(file)) throw new Error(`Journal ${journal.id} already exists`);
	writeAtomic(file, journal);
	announce(journal);
	return journal;
}

function findJournalByChat(chatId: string): Journal | null {
	return readAll().find((j) => j.chatId === chatId) ?? null;
}

function listJournals(): JournalSummary[] {
	return readAll()
		.map(summarizeJournal)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function saveJournal(journal: Journal): Journal {
	const file = journalFile(journal.id);
	if (!fs.existsSync(file)) throw new Error(`Unknown journal ${journal.id}`);
	writeAtomic(file, journal);
	announce(journal);
	return journal;
}

function deleteJournal(id: string): boolean {
	const prev = getJournal(id);
	try {
		fs.unlinkSync(journalFile(id));
	} catch {
		return false;
	}
	if (prev?.chatId) writeTombstones({ ...readTombstones(), [prev.chatId]: new Date().toISOString() });
	announce(prev ?? { id });
	return true;
}

export const journalStore: JournalStore = {
	createJournal,
	getJournal,
	findJournalByChat,
	listJournals,
	saveJournal,
	deleteJournal,
	isChatOptedOut,
	clearChatOptOut,
};
