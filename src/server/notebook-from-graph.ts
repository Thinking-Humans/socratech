/**
 * Launch a notebook from the graph (owner, 2026-11-15) — see
 * core/notebook-from-graph.ts. Teach seeds an agent cell the client runs;
 * Practice writes the exercises up front with the strong model (falling
 * back to an agent cell that poses them when the reply isn't usable).
 */

import { JournalError } from "../core/journal.ts";
import {
	PRACTICE_SYSTEM_PROMPT,
	launchTags,
	launchTitle,
	parsePracticeExercises,
	practiceCells,
	practicePrompt,
	teachCells,
	type LaunchCell,
	type NotebookLaunchInput,
} from "../core/notebook-from-graph.ts";
import type { Journal } from "../core/contracts/journal.ts";
import { addJournalCell, createJournal } from "./journals.ts";
import { NoteError } from "./notes.ts";
import { strongTextStream } from "./notes-ask.ts";

type ExerciseWriter = (system: string, prompt: string) => Promise<string>;

let writerOverride: ExerciseWriter | null = null;
/** Tests: a fake strong model for Practice. */
export function setExerciseWriterForTests(writer: ExerciseWriter | null): void {
	writerOverride = writer;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const dec = new TextDecoder();
	let text = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) return text + dec.decode();
		text += dec.decode(value, { stream: true });
	}
}

async function writeExercises(input: NotebookLaunchInput): Promise<string[] | null> {
	const prompt = practicePrompt(input.topic, input.picks);
	try {
		const reply = writerOverride
			? await writerOverride(PRACTICE_SYSTEM_PROMPT, prompt)
			: await readAll(strongTextStream(PRACTICE_SYSTEM_PROMPT, prompt, "notebook-practice"));
		return parsePracticeExercises(reply);
	} catch (err) {
		if (err instanceof NoteError) throw new JournalError(err.message, "invalid");
		console.info(`[notebook launch] exercises not written up front: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

/** Create the notebook → it, plus the agent cell the client should run (if any). */
export async function launchNotebookFromGraph(input: NotebookLaunchInput): Promise<{ journal: Journal; runCellId?: string }> {
	const cells: LaunchCell[] =
		input.mode === "teach" ? teachCells(input.topic, input.picks) : practiceCells(input.topic, input.picks, await writeExercises(input));
	let journal = createJournal({ title: launchTitle(input.topic), tags: launchTags(input.picks) });
	let runCellId: string | undefined;
	for (const cell of cells) {
		journal = addJournalCell(journal.id, { role: cell.role, source: cell.source });
		if (cell.run) runCellId = journal.cells.at(-1)!.id;
	}
	return { journal, ...(runCellId ? { runCellId } : {}) };
}
