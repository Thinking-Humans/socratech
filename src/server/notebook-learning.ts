/**
 * Notebook learning ops (owner, 2026-11-15) — see core/notebook-learning.ts.
 *
 *   rate      the learner's own rating of a cell; "stuck" inserts an agent
 *             cell above it that explains the prerequisites (the client runs it)
 *   check     the agent's cross-check: one question, the learner's answer, a verdict
 *   extract   ONLY on request (a cell) or on publish (every changed
 *             published cell). Each cell is its own graph source; re-extracting
 *             an edited cell first withdraws that cell's earlier contribution.
 *   delete    deleting an extracted cell / notebook withdraws its graph traces
 */

import { createHash } from "node:crypto";
import { deleteSourcesTraces } from "../core/graph-deletion.ts";
import { JournalError } from "../core/journal.ts";
import {
	CHECK_GRADE_SYSTEM_PROMPT,
	CHECK_QUESTION_SYSTEM_PROMPT,
	RATEABLE_ROLES,
	cellGraphStatus,
	cellSourcePath,
	checkGradePrompt,
	checkQuestionPrompt,
	extractableText,
	isPrerequisiteCell,
	parseCheckVerdict,
	prerequisiteRequest,
	textHash,
} from "../core/notebook-learning.ts";
import { extractionEnabled } from "../core/settings-resolution.ts";
import { slotsConfigured } from "../core/settings.ts";
import type { GraphImportOutcome, Journal, UnderstandingCheck, UnderstandingLevel } from "../core/contracts/journal.ts";
import type { EmissionStats } from "../core/contracts/graph.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { deleteJournal, deleteJournalCell, insertCellBefore, requireJournal, setCellLearning } from "./journals.ts";
import { NoteError } from "./notes.ts";
import { strongTextStream } from "./notes-ask.ts";
import { effectiveSettings, stores } from "./stores.ts";

// ─── graph source per cell ──────────────────────────────────────────────────

interface NotesImporter {
	importNotes(input: { filePath: string; text: string }): Promise<EmissionStats>;
}

let importerOverride: NotesImporter | null = null;
/** Tests: a fake extraction pipeline (also skips the settings gates). */
export function setNotesImporterForTests(importer: NotesImporter | null): void {
	importerOverride = importer;
}

async function importer(): Promise<NotesImporter> {
	if (importerOverride) return importerOverride;
	const { extraction } = await import("./chat-handler.ts");
	return extraction;
}

/** The graph's notes-source id for one cell (same derivation as importNotes). */
export function cellSourceId(journalId: string, cellId: string): string {
	return `src_${createHash("sha256").update(cellSourcePath(journalId, cellId)).digest("hex").slice(0, 12)}`;
}

function graphGate(): "graph-off" | "models-missing" | null {
	if (importerOverride) return null;
	if (!extractionEnabled(effectiveSettings().graph)) return "graph-off";
	if (!slotsConfigured(stores.settingsStore.readSettings()?.models)) return "models-missing";
	return null;
}

function refuseWhileExtracting(): void {
	if (extractionStatuses().length) throw new JournalError("An extraction is running — try again when it finishes.", "conflict");
}

/** Remove one cell's contribution from the graph (ideas only it supported die). */
function withdrawCell(journalId: string, cellId: string): void {
	const ids = new Set([cellSourceId(journalId, cellId)]);
	deleteSourcesTraces(stores.graphStore, ids, "delete-nodes");
	stores.graphStore.deleteSources(ids);
}

export type CellExtractOutcome = "extracted" | "unchanged" | "withdrawn" | "nothing" | "graph-off" | "models-missing";

const extracting = new Set<string>();

/**
 * Extract one cell into the graph — on request or from publish. Unchanged
 * text is a no-op; edited text replaces the cell's earlier contribution; a
 * cell emptied of text withdraws it.
 */
export async function extractCell(id: string, cellId: string): Promise<{ journal: Journal; outcome: CellExtractOutcome; stats?: EmissionStats }> {
	const gate = graphGate();
	if (gate) return { journal: requireJournal(id), outcome: gate };
	const key = `${id}/${cellId}`;
	if (extracting.has(key)) throw new JournalError("This cell is already being extracted.", "conflict");
	extracting.add(key);
	try {
		const journal = requireJournal(id);
		const cell = journal.cells.find((c) => c.id === cellId);
		if (!cell) throw new JournalError(`No cell [${cellId}] in journal [${id}].`, "not_found");
		const text = extractableText(cell);
		if (text === null) {
			if (!cell.graph) return { journal, outcome: "nothing" };
			refuseWhileExtracting();
			withdrawCell(id, cellId);
			return { journal: setCellLearning(id, cellId, { graph: null }), outcome: "withdrawn" };
		}
		const hash = textHash(text);
		if (cell.graph?.hash === hash) return { journal, outcome: "unchanged" };
		refuseWhileExtracting();
		if (cell.graph) withdrawCell(id, cellId);
		let stats: EmissionStats;
		try {
			stats = await (await importer()).importNotes({ filePath: cellSourcePath(id, cellId), text: `# ${journal.title}\n\n${text}` });
		} catch (err) {
			throw new JournalError(`Extraction failed: ${err instanceof Error ? err.message : String(err)}`, "invalid");
		}
		const updated = setCellLearning(id, cellId, {
			graph: { hash, at: new Date().toISOString(), nodes: stats.nodes, chains: stats.chains ?? 0 },
		});
		return { journal: updated, outcome: "extracted", stats };
	} finally {
		extracting.delete(key);
	}
}

/** Publish: extract every published cell that is new or changed, one after another (fire-and-forget). */
export function extractPublishedCells(journal: Journal): GraphImportOutcome {
	if (process.env.NODE_ENV === "test" && !importerOverride) return "test";
	const gate = graphGate();
	if (gate) return gate;
	const todo = journal.cells.filter((c) => c.publish && extractableText(c) !== null && cellGraphStatus(c) !== "current").map((c) => c.id);
	if (todo.length === 0) return "unchanged";
	void (async () => {
		for (const cellId of todo) {
			try {
				await extractCell(journal.id, cellId);
			} catch (err) {
				console.info(`[notebook ${journal.id}] cell ${cellId} extraction skipped: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	})();
	return "started";
}

/** Delete a cell; an extracted one leaves the graph with it. */
export function deleteNotebookCell(id: string, cellId: string): Journal {
	const cell = requireJournal(id).cells.find((c) => c.id === cellId);
	if (cell?.graph) {
		refuseWhileExtracting();
		withdrawCell(id, cellId);
	}
	return deleteJournalCell(id, cellId);
}

/** Delete a notebook; every extracted cell leaves the graph with it. */
export function deleteNotebook(id: string): boolean {
	const journal = stores.journalStore.getJournal(id);
	const extracted = journal?.cells.filter((c) => c.graph) ?? [];
	if (extracted.length) {
		refuseWhileExtracting();
		for (const c of extracted) withdrawCell(id, c.id);
	}
	return deleteJournal(id);
}

// ─── rating ─────────────────────────────────────────────────────────────────

/**
 * Rate a cell (null clears). "stuck" puts a prerequisites agent cell right
 * above it (reusing one already there) → its id, for the client to run.
 */
export function rateCell(id: string, cellId: string, level: UnderstandingLevel | null): { journal: Journal; prereqCellId?: string } {
	const journal = requireJournal(id);
	const at = journal.cells.findIndex((c) => c.id === cellId);
	const cell = journal.cells[at];
	if (!cell) throw new JournalError(`No cell [${cellId}] in journal [${id}].`, "not_found");
	if (!RATEABLE_ROLES.includes(cell.role)) throw new JournalError("Only markdown and code cells are rated.", "invalid");
	if (level === null) return { journal: setCellLearning(id, cellId, { understanding: null }) };
	const hash = textHash(cell.source);
	// A check was about this exact text — it survives a re-rating of the same text.
	const check = cell.understanding?.hash === hash ? cell.understanding.check : undefined;
	let next = setCellLearning(id, cellId, { understanding: { level, hash, at: new Date().toISOString(), ...(check ? { check } : {}) } });
	if (level !== "stuck") return { journal: next };
	const above = next.cells[at - 1];
	if (isPrerequisiteCell(above)) return { journal: next, prereqCellId: above!.id };
	const inserted = insertCellBefore(id, cellId, { role: "agent", source: prerequisiteRequest(at + 1) });
	next = inserted.journal;
	return { journal: next, prereqCellId: inserted.cellId };
}

// ─── the agent's cross-check ────────────────────────────────────────────────

function strong(system: string, prompt: string, prefix: string): ReadableStream<Uint8Array> {
	try {
		return strongTextStream(system, prompt, prefix);
	} catch (err) {
		if (err instanceof NoteError) throw new JournalError(err.message, "invalid");
		throw err;
	}
}

/** Stream one check question about the cell. */
export function checkQuestionStream(id: string, cellId: string): ReadableStream<Uint8Array> {
	return strong(CHECK_QUESTION_SYSTEM_PROMPT, checkQuestionPrompt(requireJournal(id), cellId), "notebook-check");
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

/** Grade the learner's answer and keep the check on the cell's rating. */
export async function gradeCheck(id: string, cellId: string, question: string, answer: string): Promise<{ journal: Journal; check: UnderstandingCheck }> {
	if (!question.trim() || !answer.trim()) throw new JournalError("question and answer are required", "invalid");
	const cell = requireJournal(id).cells.find((c) => c.id === cellId);
	if (!cell) throw new JournalError(`No cell [${cellId}] in journal [${id}].`, "not_found");
	if (!cell.understanding) throw new JournalError("Rate the cell first — the check cross-checks your rating.", "invalid");
	const reply = await readAll(strong(CHECK_GRADE_SYSTEM_PROMPT, checkGradePrompt(requireJournal(id), cellId, question, answer), "notebook-grade"));
	if (/^\s*$/.test(reply) || /\*\(failed: /.test(reply)) throw new JournalError(reply.replace(/[*()]/g, "").trim() || "The grader returned nothing.", "invalid");
	const check: UnderstandingCheck = { question: question.trim(), answer: answer.trim(), ...parseCheckVerdict(reply), at: new Date().toISOString() };
	const fresh = requireJournal(id).cells.find((c) => c.id === cellId);
	if (!fresh?.understanding) throw new JournalError("The rating was cleared while grading.", "conflict");
	return { journal: setCellLearning(id, cellId, { understanding: { ...fresh.understanding, check } }), check };
}
