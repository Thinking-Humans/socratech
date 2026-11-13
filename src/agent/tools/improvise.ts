/**
 * THE IMPROVISE TOOLS (improvise sessions, owner design 2026-10-30 — the
 * cognitive gym's third phase, after Ido Portal's isolate → integrate →
 * improvise): practice's problem/conclude loop, so the dock, the cards
 * and the active-problem fold all carry over, with improvise's own
 * schemas —
 *
 *   problem   pose ONE improvisation challenge on named idea nodes: a move
 *             (context-shift | variant), a medium, and the CRITERIA a
 *             passing attempt must preserve — committed before the pose,
 *             hidden until conclude (practice's commit-before-pose law).
 *   conclude  judge the attempt pass/fail — appends ONE improvisation
 *             judgment to the graph ledger (the session's only graph
 *             write); "surrendered" records nothing (owner: a give-up is
 *             no judgment).
 *   rejudge   the contest channel: in the pause after a judged problem,
 *             the learner pushes back; every contest — upheld or changed —
 *             appends a revising judgment (append-only — the original
 *             stays as history, core/improvisation.ts reads the latest;
 *             an upheld revision derives the identical standing).
 *
 * Mechanics-only descriptions (the practice doctrine ruling): the method
 * lives in prompts/improvise/.
 */

import { randomBytes } from "node:crypto";
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { resolveTargetId } from "../../core/chains.ts";
import { CONCLUDE_ACK_TEXT } from "../../core/contracts/chat.ts";
import type { GraphNode, ImprovisationJudgment } from "../../core/contracts/graph.ts";
import { activeProblemOf, PRACTICE_CONCLUDE_TOOL } from "../../core/native-messages.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { jobTools, type JobToolContext } from "./jobs.ts";
import { proberGraphTools, type GraphToolContext } from "./graph.ts";
import { invalidInputResult, problemResult } from "../tool-execute.ts";
import { healEncodedArguments, healToolRecord } from "./heal.ts";

/** The record-reading context (practice's, plus the judgment writer). */
export interface ImproviseToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[]; kind?: string } | null };
	/** The WHOLE-graph node list, read fresh per pose — targets must be
	 *  known ideas (a judgment is meaningless without them). Absent
	 *  (tests) = no validation. */
	graphNodes?: () => ReadonlyArray<Pick<GraphNode, "id" | "name">>;
	/** The judgment writer — the graph store's appendImprovisation, wired
	 *  at the composition root. ABSENT = the graph is switched off: judging
	 *  still runs, nothing is recorded, and the result says so. */
	recordJudgment?: (judgment: ImprovisationJudgment) => void;
	/** The rarely-needed set, exactly practice's. */
	graph?: GraphToolContext;
	jobs?: JobToolContext;
}

/** TURN-SCOPED GATE STATE (practice's BKT lesson: the record freezes at the
 *  turn's write-ahead, so intra-turn truth lives in this closure, seeded
 *  once from the record). */
export interface ImproviseGate {
	problemActive: boolean;
	/** The latest RECORDED judgment of the newest concluded problem — what
	 *  a contest revises. Null while a problem is active, after a
	 *  surrender/dismissal, or when nothing was recorded. */
	lastJudgment: ImprovisationJudgment | null;
}

/** The details a conclude/rejudge result carries: the judgment it
 *  recorded (null = nothing recorded). The record is the gate's seed. */
interface JudgmentDetails {
	judgment: ImprovisationJudgment | null;
}

export function createImproviseGate(ctx: ImproviseToolContext): ImproviseGate {
	const record = ctx.chatStore.getChat(ctx.chatId);
	const messages = record?.messages ?? [];
	const problemActive = activeProblemOf(messages) !== null;
	return { problemActive, lastJudgment: problemActive ? null : lastJudgmentOf(messages) };
}

/** The newest judgment a clean conclude/rejudge result recorded — stopping
 *  at the newest conclude (a surrendered or dismissed problem ends the
 *  contest window for everything before it). */
function lastJudgmentOf(messages: readonly LhMessage[]): ImprovisationJudgment | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "toolResult" || m.isError) continue;
		if (m.toolName !== PRACTICE_CONCLUDE_TOOL && m.toolName !== "rejudge") continue;
		const judgment = (m.details as Partial<JudgmentDetails> | null | undefined)?.judgment ?? null;
		if (judgment !== null || m.toolName === PRACTICE_CONCLUDE_TOOL) return judgment;
	}
	return null;
}

/** The learner's attempt at one problem: every thinking submission for it,
 *  in order, plus the newest one's message id (the judgment's anchor). */
function attemptFor(messages: readonly LhMessage[], problemCallId: string): { text: string; messageId: string } | null {
	const parts: string[] = [];
	let messageId = "";
	for (const m of messages) {
		if (m.role !== "custom" || m.customType !== "practice-thinking") continue;
		const details = m.details as { problemCallId?: unknown; text?: unknown };
		if (details.problemCallId !== problemCallId || typeof details.text !== "string") continue;
		if (details.text.trim().length === 0) continue;
		parts.push(details.text.trim());
		messageId = m.id;
	}
	return parts.length === 0 ? null : { text: parts.join("\n\n"), messageId };
}

/** The newest learner-authored message id (a contest's anchor). */
function latestLearnerMessageId(messages: readonly LhMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "user" || (m.role === "custom" && m.customType === "practice-thinking")) return m.id;
	}
	return "";
}

/** "impr_" + 12 hex chars — the core/graph.ts id pattern. */
function newJudgmentId(): string {
	return `impr_${randomBytes(6).toString("hex")}`;
}

function judgmentResult(text: string, judgment: ImprovisationJudgment | null): AgentToolResult<JudgmentDetails> {
	return { content: [{ type: "text", text }], details: { judgment } };
}

const NOT_RECORDED = " (The graph is switched off, so this judgment was not recorded.)";

// ─── problem: the improvisation challenge ────────────────────────────────────

export const improviseProblemInputObject = Type.Object({
	statement: Type.String({
		description:
			"REQUIRED — the challenge as the learner sees it (markdown + LaTeX): the new context or the variation " +
			"to play in, and the medium to answer in. Never states the criteria.",
	}),
	move: Type.Union([Type.Literal("context-shift"), Type.Literal("variant")], {
		description: "REQUIRED — the move: context-shift or variant (bare words, no quotes).",
	}),
	medium: Type.Union([Type.Literal("text"), Type.Literal("speech")], {
		description: "REQUIRED — the medium the learner answers in: text or speech (bare words, no quotes).",
	}),
	target: Type.Array(Type.String(), {
		minItems: 1,
		description:
			"REQUIRED — the idea id(s) this challenge exercises, from the session context's [id] list or the map " +
			"readers. Names are normalized to ids at the seam; an unknown idea is rejected.",
	}),
	criteria: Type.String({
		description:
			"REQUIRED — what a passing attempt must preserve or show, committed BEFORE the learner sees the " +
			"challenge. Hidden until conclude, which reveals it verbatim; never re-author it.",
	}),
});

export type ImproviseProblemInput = Static<typeof improviseProblemInputObject>;

export function improviseProblemTool(
	gate: ImproviseGate,
	graphNodes?: ImproviseToolContext["graphNodes"],
): AgentTool<typeof improviseProblemInputObject> {
	return {
		name: "problem",
		label: "problem",
		description:
			"Pose one improvisation challenge. Ends the turn — the learner works in the thinking field; their " +
			"submissions arrive back as labeled messages. The criteria ride this call's arguments and stay hidden " +
			"until you conclude. Only one challenge may be active — conclude it before posing the next.",
		parameters: improviseProblemInputObject,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => {
			const healed = healEncodedArguments(args, improviseProblemInputObject);
			// TARGET NORMALIZATION (practice's): names silently become ids, so
			// the record and the judgments carry canonical ids.
			const target = (healed as { target?: unknown }).target;
			if (!graphNodes || !Array.isArray(target)) return healed as never;
			const list = graphNodes();
			const normalized = target.map((t) => (typeof t === "string" ? (resolveTargetId(t, list) ?? t) : t));
			if (normalized.every((t, i) => t === target[i])) return healed as never;
			return { ...(healed as Record<string, unknown>), target: normalized } as never;
		},
		execute: async (_toolCallId, input) => {
			if (gate.problemActive) {
				return invalidInputResult("problem", [
					"a challenge is already active — call conclude on it before posing the next one",
				]);
			}
			if (graphNodes) {
				const list = graphNodes();
				const unknown = input.target.filter((t) => resolveTargetId(t, list) === null);
				if (unknown.length > 0) {
					return invalidInputResult("problem", [
						`target ${JSON.stringify(unknown)} is not a known idea — targets must be idea ids from the session context or the map readers`,
					]);
				}
			}
			gate.problemActive = true;
			gate.lastJudgment = null;
			return problemResult();
		},
	};
}

// ─── conclude: the judgment ──────────────────────────────────────────────────

export const improviseConcludeInputObject = Type.Object({
	outcome: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("surrendered")], {
		description:
			"REQUIRED — pass, fail, or surrendered (the learner gave up — nothing is recorded) — bare words, no " +
			"quotes (dismissed is synthesized, never yours).",
	}),
	verdict: Type.String({
		description: "REQUIRED — the plain-language judgment against the criteria: what carried over, where it broke.",
	}),
});

export type ImproviseConcludeInput = Static<typeof improviseConcludeInputObject>;

export function improviseConcludeTool(gate: ImproviseGate, ctx: ImproviseToolContext): AgentTool<typeof improviseConcludeInputObject> {
	return {
		name: "conclude",
		label: "conclude",
		description:
			"Conclude the active challenge: pass or fail records ONE improvisation judgment for its target ideas; " +
			"surrendered records nothing. Reveals the committed criteria. After the result, say your closing words " +
			"if useful, then END YOUR TURN — the next challenge waits for the learner's explicit go-ahead.",
		parameters: improviseConcludeInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, improviseConcludeInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			if (!gate.problemActive) {
				return invalidInputResult("conclude", ["no active challenge to conclude — pose one first"]);
			}
			const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
			const active = activeProblemOf(messages);
			if (input.outcome === "surrendered") {
				gate.problemActive = false;
				gate.lastJudgment = null;
				return judgmentResult(CONCLUDE_ACK_TEXT, null);
			}
			const pose = active?.input as Partial<ImproviseProblemInput> | undefined;
			const attempt = active ? attemptFor(messages, active.toolCallId) : null;
			if (!active || !pose || !attempt) {
				return invalidInputResult("conclude", [
					"no attempt has arrived for this challenge — pass/fail judges a real attempt; conclude as surrendered if the learner gave up",
				]);
			}
			const judgment: ImprovisationJudgment = {
				id: newJudgmentId(),
				nodeIds: [...new Set(pose.target ?? [])],
				move: pose.move ?? "context-shift",
				medium: pose.medium ?? "text",
				challenge: pose.statement ?? "",
				attempt: attempt.text,
				verdict: input.outcome,
				rationale: input.verdict,
				provenance: { chatId: ctx.chatId, messageId: attempt.messageId },
				at: new Date().toISOString(),
			};
			gate.problemActive = false;
			if (!ctx.recordJudgment) {
				gate.lastJudgment = null;
				return judgmentResult(CONCLUDE_ACK_TEXT + NOT_RECORDED, null);
			}
			ctx.recordJudgment(judgment);
			gate.lastJudgment = judgment;
			return judgmentResult(CONCLUDE_ACK_TEXT, judgment);
		},
	};
}

// ─── rejudge: the contest ────────────────────────────────────────────────────

export const rejudgeInputObject = Type.Object({
	contest: Type.String({
		description: "REQUIRED — the learner's contest, verbatim from their message.",
	}),
	verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")], {
		description: "REQUIRED — the re-examined verdict: pass or fail (bare words) — the same one when it is upheld.",
	}),
	rationale: Type.String({
		description: "REQUIRED — why the verdict stands or changes, against the same criteria.",
	}),
});

export type RejudgeInput = Static<typeof rejudgeInputObject>;

export function rejudgeTool(gate: ImproviseGate, ctx: ImproviseToolContext): AgentTool<typeof rejudgeInputObject> {
	return {
		name: "rejudge",
		label: "rejudge",
		description:
			"Re-examine the most recently judged challenge after the learner contests it — upheld or changed, " +
			"every contest is recorded as a revising judgment (the original stays as history). Only between " +
			"challenges.",
		parameters: rejudgeInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, rejudgeInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const prev = gate.lastJudgment;
			if (gate.problemActive || prev === null) {
				return invalidInputResult("rejudge", [
					"nothing to rejudge — only the most recently judged challenge can be contested, between challenges",
				]);
			}
			// The re-examination judges the SAME attempt, so it keeps the
			// original's time — the ladder clock does not move on a contest.
			const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
			const judgment: ImprovisationJudgment = {
				...prev,
				id: newJudgmentId(),
				verdict: input.verdict,
				rationale: input.rationale,
				provenance: { chatId: ctx.chatId, messageId: latestLearnerMessageId(messages) },
				revises: prev.id,
				contest: input.contest,
			};
			const outcome = input.verdict === prev.verdict ? `Verdict upheld: ${input.verdict}.` : `Verdict changed to ${input.verdict}.`;
			if (!ctx.recordJudgment) return judgmentResult(`${outcome}${NOT_RECORDED}`, null);
			ctx.recordJudgment(judgment);
			gate.lastJudgment = judgment;
			return judgmentResult(`${outcome} Recorded. Say so briefly, then END YOUR TURN.`, judgment);
		},
	};
}

/** The improvise toolset (the improvise agent's whole registry). */
export function improviseTools(ctx: ImproviseToolContext): Record<string, AgentTool<any>> {
	// ONE gate per turn, shared by the three tools — the intra-turn truth.
	const gate = createImproviseGate(ctx);
	const jobs = ctx.jobs ? jobTools(ctx.jobs) : null;
	return healToolRecord({
		problem: improviseProblemTool(gate, ctx.graphNodes),
		conclude: improviseConcludeTool(gate, ctx),
		rejudge: rejudgeTool(gate, ctx),
		read: readTool,
		ls: lsTool,
		find: findTool,
		grep: grepTool,
		...(jobs?.research ? { research: jobs.research } : {}),
		...(jobs ? { pdf: jobs.pdf! } : {}),
		...(ctx.graph ? proberGraphTools(ctx.graph) : {}),
	});
}
