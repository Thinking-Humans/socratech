/**
 * Journal media store (owner, 2026-11-15): images / videos embedded in
 * markdown cells live in data/journal-media/<journalId>/<name>. Uploads
 * stream to disk (no whole-file buffering, size-capped); publish copies the
 * referenced ones into the post bundle's media/ folder.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { PATHS } from "../../config.ts";
import { JournalError } from "../core/journal.ts";
import { MAX_MEDIA_BYTES, isMediaName, isSafeMediaName, mediaFileName, mediaMarkdown } from "../core/journal-media.ts";
import { requireJournal } from "./journals.ts";

export function journalMediaDir(journalId: string): string {
	return path.join(PATHS.data, "journal-media", journalId.replace(/[^\w-]/g, "_"));
}

/** Absolute path of a stored media file, or null when the name is unsafe / missing. */
export function journalMediaFile(journalId: string, name: string): string | null {
	if (!isSafeMediaName(name)) return null;
	const file = path.join(journalMediaDir(journalId), name);
	return fs.existsSync(file) ? file : null;
}

/** Stream an upload to the store → its stored name + the markdown to embed it. */
export async function saveJournalMedia(
	journalId: string,
	originalName: string,
	body: ReadableStream<Uint8Array> | null,
): Promise<{ name: string; markdown: string; bytes: number }> {
	requireJournal(journalId);
	if (!body) throw new JournalError("The upload is empty.", "invalid");
	if (!isMediaName(originalName)) throw new JournalError("Only images (png, jpg, gif, webp, svg, avif) and videos (mp4, webm, mov, m4v, ogv) embed.", "invalid");
	const dir = journalMediaDir(journalId);
	fs.mkdirSync(dir, { recursive: true });
	const name = mediaFileName(originalName, randomUUID().slice(0, 6));
	const tmp = path.join(dir, `.${name}.part`);
	let bytes = 0;
	const cap = new Transform({
		transform(chunk: Buffer, _enc, done) {
			bytes += chunk.length;
			if (bytes > MAX_MEDIA_BYTES) done(new JournalError(`Files are capped at ${MAX_MEDIA_BYTES / 1024 / 1024} MB.`, "invalid"));
			else done(null, chunk);
		},
	});
	try {
		await pipeline(Readable.fromWeb(body as never), cap, fs.createWriteStream(tmp));
		if (bytes === 0) throw new JournalError("The upload is empty.", "invalid");
		fs.renameSync(tmp, path.join(dir, name));
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
	return { name, markdown: mediaMarkdown(name, originalName.replace(/\.[^.]*$/, "")), bytes };
}
