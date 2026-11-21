/**
 * Notebook learning ops (owner, 2026-11-15) — see core/notebook-learning.ts.
 *
 *   rate      the learner's own rating of a cell; "stuck" inserts an agent
 *             cell above it that explains the prerequisites (the client runs it)
 *   check     the agent's cross-check: one question, the learner's answer, a verdict
 *   extract   ONLY on request or on publish. The NOTEBOOK is the graph
 *             source (owner, 2026-11-15); re-extracting an edited notebook
 *             first withdraws its earlier contribution.
 *   delete    deleting an extracted notebook withdraws its graph traces
 */

import { createHash } from "node:crypto";
import { deleteSourcesTraces } from "../core/graph-deletion.ts";
import { JournalError } from "../core/journal.ts";
import {
	CHECK_GRADE_SYSTEM_PROMPT,
	CHECK_QUESTION_SYSTEM_PROMPT,
	RATEABLE_ROLES,
	checkGradePrompt,
	checkQuestionPrompt,
	isPrerequisiteCell,
	legacyCellSourcePath,
	levelForConfidence,
	notebookExtractableText,
	notebookGraphStatus,
	notebookSourcePath,
	parseCheckVerdict,
	prerequisiteRequest,
	snapConfidence,
	textHash,
} from "../core/notebook-learning.ts";
import { extractionEnabled } from "../core/settings-resolution.ts";
import { slotsConfigured } from "../core/settings.ts";
import type { GraphImportOutcome, Journal, UnderstandingCheck } from "../core/contracts/journal.ts";
import type { EmissionStats } from "../core/contracts/graph.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { deleteJournal, deleteJournalCell, insertCellBefore, requireJournal, setCellLearning, setNotebookGraph } from "./journals.ts";
import { ModelTextError, strongTextStream } from "./model-text.ts";
import { effectiveSettings, stores } from "./stores.ts";

// ─── graph source per notebook ──────────────────────────────────────────────

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

/** The graph's notes-source id for a source path (same derivation as importNotes). */
function sourceIdOf(filePath: string): string {
	return `src_${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;
}

/** The graph's notes-source id for one notebook. */
export function notebookSourceId(journalId: string): string {
	return sourceIdOf(notebookSourcePath(journalId));
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

/** Remove a notebook's contribution (and any legacy per-cell one) from the graph. */
function withdrawNotebook(journal: Journal): void {
	const ids = new Set([notebookSourceId(journal.id)]);
	for (const c of journal.cells) if (c.graph) ids.add(sourceIdOf(legacyCellSourcePath(journal.id, c.id)));
	deleteSourcesTraces(stores.graphStore, ids, "delete-nodes");
	stores.graphStore.deleteSources(ids);
}

const hasGraphTraces = (journal: Journal) => journal.graph !== undefined || journal.cells.some((c) => c.graph);

export type NotebookExtractOutcome = "extracted" | "unchanged" | "withdrawn" | "nothing" | "graph-off" | "models-missing";

const extracting = new Set<string>();

/**
 * Read a whole notebook into the graph — on request or from publish.
 * Unchanged text is a no-op; edited text replaces the notebook's earlier
 * contribution; a notebook emptied of learner writing withdraws it.
 */
export async function extractNotebook(id: string): Promise<{ journal: Journal; outcome: NotebookExtractOutcome; stats?: EmissionStats }> {
	const gate = graphGate();
	if (gate) return { journal: requireJournal(id), outcome: gate };
	if (extracting.has(id)) throw new JournalError("This notebook is already being read into the graph.", "conflict");
	extracting.add(id);
	try {
		const journal = requireJournal(id);
		const text = notebookExtractableText(journal);
		if (text === null) {
			if (!hasGraphTraces(journal)) return { journal, outcome: "nothing" };
			refuseWhileExtracting();
			withdrawNotebook(journal);
			return { journal: setNotebookGraph(id, null), outcome: "withdrawn" };
		}
		const hash = textHash(text);
		if (journal.graph?.hash === hash && !journal.cells.some((c) => c.graph)) return { journal, outcome: "unchanged" };
		refuseWhileExtracting();
		if (hasGraphTraces(journal)) withdrawNotebook(journal);
		let stats: EmissionStats;
		try {
			stats = await (await importer()).importNotes({ filePath: notebookSourcePath(id), text: `# ${journal.title}\n\n${text}` });
		} catch (err) {
			throw new JournalError(`Extraction failed: ${err instanceof Error ? err.message : String(err)}`, "invalid");
		}
		const updated = setNotebookGraph(id, { hash, at: new Date().toISOString(), nodes: stats.nodes, chains: stats.chains ?? 0 });
		return { journal: updated, outcome: "extracted", stats };
	} finally {
		extracting.delete(id);
	}
}

/** Publish: read the notebook into the graph when it is new or changed (fire-and-forget). */
export function extractPublishedNotebook(journal: Journal): GraphImportOutcome {
	if (process.env.NODE_ENV === "test" && !importerOverride) return "test";
	const gate = graphGate();
	if (gate) return gate;
	if (notebookExtractableText(journal) === null && !hasGraphTraces(journal)) return "nothing";
	if (notebookGraphStatus(journal) === "current" && !journal.cells.some((c) => c.graph)) return "unchanged";
	void extractNotebook(journal.id).catch((err) => {
		console.info(`[notebook ${journal.id}] extraction skipped: ${err instanceof Error ? err.message : String(err)}`);
	});
	return "started";
}

/** Delete a cell. The notebook's graph contribution goes stale until it is read again. */
export function deleteNotebookCell(id: string, cellId: string): Journal {
	return deleteJournalCell(id, cellId);
}

/** Delete a notebook; its graph contribution leaves with it. */
export function deleteNotebook(id: string): boolean {
	const journal = stores.journalStore.getJournal(id);
	if (journal && hasGraphTraces(journal)) {
		refuseWhileExtracting();
		withdrawNotebook(journal);
	}
	return deleteJournal(id);
}

// ─── rating ─────────────────────────────────────────────────────────────────

/**
 * Rate a cell's confidence 0–100 (null clears; snapped to the stops). 0%
 * ("stuck") puts a prerequisites agent cell right above it (reusing one
 * already there) → its id, for the client to run.
 */
export function rateCell(id: string, cellId: string, confidence: number | null): { journal: Journal; prereqCellId?: string } {
	const journal = requireJournal(id);
	const at = journal.cells.findIndex((c) => c.id === cellId);
	const cell = journal.cells[at];
	if (!cell) throw new JournalError(`No cell [${cellId}] in journal [${id}].`, "not_found");
	if (!RATEABLE_ROLES.includes(cell.role)) throw new JournalError("Only markdown and code cells are rated.", "invalid");
	if (confidence === null) return { journal: setCellLearning(id, cellId, { understanding: null }) };
	const snapped = snapConfidence(confidence);
	const level = levelForConfidence(snapped);
	const hash = textHash(cell.source);
	// A check was about this exact text — it survives a re-rating of the same text.
	const check = cell.understanding?.hash === hash ? cell.understanding.check : undefined;
	let next = setCellLearning(id, cellId, { understanding: { level, confidence: snapped, hash, at: new Date().toISOString(), ...(check ? { check } : {}) } });
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
		if (err instanceof ModelTextError) throw new JournalError(err.message, "invalid");
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
