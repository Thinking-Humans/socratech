/** Scratchpad service seam (Mod+P): read / replace the one text buffer. */

import { JournalError } from "../core/journal.ts";
import { readScratchpadFile, writeScratchpadFile } from "../store/scratchpad.ts";

/** Asides, not documents: a megabyte of characters is plenty. */
export const SCRATCHPAD_MAX_CHARS = 1_000_000;

export function readScratchpad(): string {
	return readScratchpadFile();
}

/** Untrusted body → saved text. */
export function writeScratchpad(body: Record<string, unknown>): string {
	const text = body.text;
	if (typeof text !== "string") throw new JournalError("text (string) is required", "invalid");
	if (text.length > SCRATCHPAD_MAX_CHARS) throw new JournalError("The scratchpad is too long to save.", "invalid");
	writeScratchpadFile(text);
	return text;
}
