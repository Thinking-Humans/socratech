/**
 * Session → journal drafts (learn-in-public phase 2, 2026-11-15). Pure:
 * reads a practice / improvise record and proposes the session-derived
 * cells; the server seam (src/server/journals.ts) upserts them, so a
 * replay never duplicates and a cell the learner edited is never
 * overwritten.
 *
 *   exercise  each CLEAN `problem` pose — its statement; ideas = target
 *   attempt   on a clean pass/fail/surrender conclude — the learner's LAST
 *             thinking submission on that problem (earlier ones are drafts)
 *   verdict   the same conclude — outcome, verdict, and the reveal
 *             (practice: model solution; improvise: criteria)
 *   verdict   each clean `rejudge` — the re-examined verdict
 *
 * A dismissed problem yields its exercise only. Honest activation (the
 * native-messages law): errored calls never happened and yield nothing.
 * Every draft's origin key is the problem's toolCallId (rejudges: their
 * own), so (toolCallId, role) is unique per draft.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "./native-messages.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL } from "./native-messages.ts";
import type { JournalCellOrigin, JournalCellRole } from "./contracts/journal.ts";

export interface SessionCellDraft {
	role: Extract<JournalCellRole, "exercise" | "attempt" | "verdict">;
	source: string;
	origin: JournalCellOrigin;
}

const REJUDGE_TOOL = "rejudge";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function outcomeLabel(outcome: string): string {
	const spaced = outcome.replace(/([a-z])([A-Z])/g, (_, lo: string, hi: string) => `${lo} ${hi.toLowerCase()}`);
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function quote(label: string, text: string): string {
	return `> **${label}**\n>\n> ${text.replace(/\n/g, "\n> ")}`;
}

export function sessionJournalDrafts(chatId: string, messages: readonly LhMessage[]): SessionCellDraft[] {
	const clean = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult" && !(m as ToolResultMessage).isError) {
			clean.add((m as ToolResultMessage).toolCallId);
		}
	}

	const drafts: SessionCellDraft[] = [];
	/** The newest clean pose not yet concluded. */
	let active: { id: string; args: Record<string, unknown>; ideaIds: string[] } | null = null;
	/** The last judged problem (a rejudge re-examines it). */
	let judged: { ideaIds: string[] } | null = null;
	const lastThinking = new Map<string, string>();

	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as { customType?: string; details?: { problemCallId?: unknown; text?: unknown } };
			if (marker.customType === "practice-thinking") {
				const pid = marker.details?.problemCallId;
				const text = str(marker.details?.text);
				if (typeof pid === "string" && text) lastThinking.set(pid, text);
			}
			continue;
		}
		if (role !== "assistant") continue;
		for (const block of (m as AssistantMessage).content) {
			if (block.type !== "toolCall" || !clean.has(block.id)) continue;
			const args = (block.arguments ?? {}) as Record<string, unknown>;

			if (block.name === PRACTICE_PROBLEM_TOOL) {
				const ideaIds = Array.isArray(args.target) ? args.target.filter((t): t is string => typeof t === "string") : [];
				active = { id: block.id, args, ideaIds };
				const statement = str(args.statement);
				if (statement) drafts.push({ role: "exercise", source: statement, origin: { chatId, toolCallId: block.id, ideaIds } });
				continue;
			}

			if (block.name === PRACTICE_CONCLUDE_TOOL) {
				const pose = active;
				active = null;
				const outcome = str(args.outcome);
				if (!pose || outcome === "dismissed" || outcome === "") continue;
				const origin = { chatId, toolCallId: pose.id, ideaIds: pose.ideaIds };
				const attempt = lastThinking.get(pose.id);
				if (attempt) drafts.push({ role: "attempt", source: attempt, origin });
				const parts = [`**${outcomeLabel(outcome)}.**${str(args.verdict) ? ` ${str(args.verdict)}` : ""}`];
				const solution = str(pose.args.modelSolution);
				const criteria = str(pose.args.criteria);
				if (solution) parts.push(quote("Model solution", solution));
				else if (criteria) parts.push(quote("Criteria", criteria));
				drafts.push({ role: "verdict", source: parts.join("\n\n"), origin });
				judged = { ideaIds: pose.ideaIds };
				continue;
			}

			if (block.name === REJUDGE_TOOL && judged) {
				// rejudge args: contest (verbatim), verdict (pass|fail), rationale.
				const verdict = str(args.verdict);
				const rationale = str(args.rationale);
				const contest = str(args.contest);
				const head = `**Rejudged${verdict ? `: ${outcomeLabel(verdict)}` : ""}.**${rationale ? ` ${rationale}` : ""}`;
				drafts.push({
					role: "verdict",
					source: contest ? `${head}\n\n${quote("Contest", contest)}` : head,
					origin: { chatId, toolCallId: block.id, ideaIds: judged.ideaIds },
				});
			}
		}
	}
	return drafts;
}
