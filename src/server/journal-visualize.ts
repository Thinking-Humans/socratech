/**
 * V on a notebook cell (owner, 2026-11-21): a 3Blue1Brown-style interactive
 * visual of the cell's idea. The demo builder writes one self-contained HTML
 * document under the visualizer skill's look (skills/visualizer/SKILL.md),
 * tests it headlessly and iterates; the result lands in the notebook's media
 * store and a markdown cell embedding it is inserted right below the source
 * cell.
 *
 * Wire: text/plain lines. Progress lines are free text; the last line is
 * `@@done <newCellId>` or `@@failed <reason>`.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { runDemoBuilder } from "../agent/subagents/demo-builder.ts";
import { flashcardSourceText, visualizeBrief } from "../core/journal-code.ts";
import { JournalError } from "../core/journal.ts";
import { mediaFileName, mediaMarkdown } from "../core/journal-media.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { journalMediaDir } from "./journal-media.ts";
import { addJournalCell, requireJournal } from "./journals.ts";
import { stores } from "./stores.ts";

export const VISUAL_DONE = "@@done ";
export const VISUAL_FAILED = "@@failed ";

/** The skill body (frontmatter dropped): the builder's look + story guide. */
function visualizerLook(): string {
	const raw = fs.readFileSync(PATHS.visualizerSkill, "utf8");
	return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

/** Validate up front (route answers 4xx before streaming). */
export function assertVisualizable(id: string, cellId: string): void {
	if (!resolveRoleSpec("demoBuilder", stores.settingsStore.readSettings()))
		throw new JournalError("No cheap model set — the visualizer uses it. Pick one in Settings → Models.", "invalid");
	const cell = requireJournal(id).cells.find((c) => c.id === cellId);
	if (!cell) throw new JournalError(`No cell [${cellId}] in journal [${id}].`, "not_found");
	if (flashcardSourceText(cell) === null) throw new JournalError("The cell is empty — nothing to visualize.", "invalid");
}

export function journalVisualizeStream(id: string, cellId: string, signal?: AbortSignal): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			let open = true;
			const line = (text: string) => {
				if (!open) return;
				try {
					controller.enqueue(enc.encode(`${text.replace(/\n/g, " ")}\n`));
				} catch {
					open = false;
				}
			};
			try {
				const { title, brief } = visualizeBrief(requireJournal(id), cellId);
				// The demo builder's role (cheap slot) — injected, as the chat runner does.
				const spec = resolveRoleSpec("demoBuilder", stores.settingsStore.readSettings());
				if (!spec) return line(`${VISUAL_FAILED}no cheap model set (Settings → Models)`);
				line("planning the visual");
				const result = await runDemoBuilder(
					{ title, brief },
					{ engine: piEngineForSpec(spec, true), look: visualizerLook(), abortSignal: signal, onActivity: line, maxSteps: 30 },
				);
				if (signal?.aborted) return line(`${VISUAL_FAILED}cancelled`);
				if (!result.html) return line(`${VISUAL_FAILED}${(result.notes ?? "the visual could not be built").replace(/^FAILED:\s*/, "")}`);
				const dir = journalMediaDir(id);
				fs.mkdirSync(dir, { recursive: true });
				const name = mediaFileName(`${title}.html`, randomUUID().slice(0, 6));
				fs.writeFileSync(path.join(dir, name), result.html);
				// The cell is just the visual: the builder's notes describe its own
				// test loop and controls the visual already labels.
				const journal = addJournalCell(id, { role: "reflection", source: mediaMarkdown(name, title) }, cellId);
				const at = journal.cells.findIndex((c) => c.id === cellId);
				line(`${VISUAL_DONE}${journal.cells[at + 1]?.id ?? ""}`);
			} catch (err) {
				line(`${VISUAL_FAILED}${err instanceof Error ? err.message : String(err)}`);
			} finally {
				if (open) {
					try {
						controller.close();
					} catch {
						// reader already gone
					}
				}
			}
		},
	});
}
