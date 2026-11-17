/**
 * The scratchpad (Mod+P, owner 2026-11-17): one plain-text file in the data
 * directory. No ids, no history — the same buffer every time the app opens.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export function readScratchpadFile(): string {
	try {
		return fs.readFileSync(PATHS.scratchpad, "utf-8");
	} catch {
		return "";
	}
}

export function writeScratchpadFile(text: string): void {
	fs.mkdirSync(path.dirname(PATHS.scratchpad), { recursive: true });
	writeFileAtomicSync(PATHS.scratchpad, text);
}
