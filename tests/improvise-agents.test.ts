/**
 * THE IMPROVISE AGENT (improvise sessions, owner design 2026-10-30): the
 * gating law it shares with practice, the judgment each pass/fail conclude
 * records (and the ones it must not — surrender, graph off, no attempt),
 * the contest channel (rejudge: revise, never uphold; the original's
 * clock), the registry, the prompt composition, and the kind plumbing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

import {
	modelSolutionForConclude,
	newThinkingMessage,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { isProblemSessionKind } from "../src/core/contracts/chat.ts";
import type { ImprovisationJudgment } from "../src/core/contracts/graph.ts";
import { inputAppends } from "../src/core/input-events.ts";
import {
	createImproviseGate,
	improviseConcludeTool,
	improviseProblemTool,
	improviseTools,
	rejudgeTool,
	type ImproviseToolContext,
} from "../src/agent/tools/improvise.ts";
import { composeInstructions, createImproviseAgent } from "../src/agent/teacher-agent.ts";
import { allSegmentPaths } from "../src/agent/prompt-segments.ts";
import { deriveStandings } from "../src/core/improvisation.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

const STAMPS = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
} as const;

const POSE = {
	statement: "Explain opportunity cost as the rules of a playground game.",
	move: "context-shift",
	medium: "speech",
	target: ["n_oppcost"],
	criteria: "The forgone best alternative is the cost; the game must force a choice between uses of one resource.",
} as const;

function assistant(id: string, callId: string, name: string, args: Record<string, unknown>): LhMessage {
	return { id, role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], timestamp: 1, ...STAMPS } as LhMessage & AssistantMessage;
}

function result(id: string, callId: string, name: string, details: unknown = null): LhMessage {
	return {
		id,
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		details,
		isError: false,
		timestamp: 2,
	} as LhMessage & ToolResultMessage;
}

/** A posed, still-active challenge (pose + ack). */
function posed(): LhMessage[] {
	return [assistant("msg_a1", "call_p1", PRACTICE_PROBLEM_TOOL, { ...POSE }), result("msg_r1", "call_p1", PRACTICE_PROBLEM_TOOL)];
}

/** posed() plus two thinking submissions (the attempt). */
function attempted(): LhMessage[] {
	return [
		...posed(),
		{ ...newThinkingMessage("call_p1", "  Recess is the resource.  "), id: "msg_t1" },
		{ ...newThinkingMessage("call_p1", "Picking tag costs the swings."), id: "msg_t2" },
	];
}

function ctxOf(messages: LhMessage[], recorded?: ImprovisationJudgment[]): ImproviseToolContext {
	return {
		chatId: "chat_gym",
		chatStore: { getChat: () => ({ messages, kind: "improvise" }) },
		...(recorded ? { recordJudgment: (j: ImprovisationJudgment) => void recorded.push(j) } : {}),
	};
}

const problemsOf = (r: { details: unknown }) => (r.details as { problems: string[] }).problems;

// ── problem ──────────────────────────────────────────────────────────────────

describe("improvise problem — the pose", () => {
	it("acks on a quiet record and ends the turn", async () => {
		const ctx = ctxOf([]);
		const r = await improviseProblemTool(createImproviseGate(ctx)).execute("call_x", POSE as never);
		assert.equal(r.isError, undefined);
		assert.equal(r.terminate, true);
	});

	it("is rejected while a challenge is active", async () => {
		const ctx = ctxOf(posed());
		const r = await improviseProblemTool(createImproviseGate(ctx)).execute("call_x", POSE as never);
		assert.equal(r.isError, true);
		assert.match(problemsOf(r)[0]!, /already active/);
	});

	it("rejects targets that are not ideas in the map, and normalizes names to ids", async () => {
		const nodes = () => [{ id: "n_oppcost", name: "Opportunity cost" }];
		const tool = improviseProblemTool(createImproviseGate(ctxOf([])), nodes);
		const unknown = await tool.execute("call_x", { ...POSE, target: ["n_nope"] } as never);
		assert.equal(unknown.isError, true);
		assert.match(problemsOf(unknown)[0]!, /not a known idea/);
		const prepared = tool.prepareArguments!({ ...POSE, target: ["Opportunity cost"] }) as { target: string[] };
		assert.deepEqual(prepared.target, ["n_oppcost"]);
	});
});

// ── conclude ─────────────────────────────────────────────────────────────────

describe("improvise conclude — the judgment", () => {
	it("pass records ONE judgment built from the pose and the attempt", async () => {
		const recorded: ImprovisationJudgment[] = [];
		const ctx = ctxOf(attempted(), recorded);
		const r = await improviseConcludeTool(createImproviseGate(ctx), ctx).execute("call_c", { outcome: "pass", verdict: "The swings carried it." } as never);
		assert.equal(r.isError, undefined);
		assert.equal(recorded.length, 1);
		const j = recorded[0]!;
		assert.match(j.id, /^impr_[0-9a-f]{12}$/);
		assert.deepEqual(
			{ ...j, id: "", at: "" },
			{
				id: "",
				nodeIds: ["n_oppcost"],
				move: "context-shift",
				medium: "speech",
				challenge: POSE.statement,
				attempt: "Recess is the resource.\n\nPicking tag costs the swings.",
				verdict: "pass",
				rationale: "The swings carried it.",
				provenance: { chatId: "chat_gym", messageId: "msg_t2" },
				at: "",
			},
		);
		assert.ok(!Number.isNaN(Date.parse(j.at)));
		assert.deepEqual(r.details, { judgment: j });
	});

	it("pass/fail with no attempt is rejected — conclude as surrendered instead", async () => {
		const recorded: ImprovisationJudgment[] = [];
		const ctx = ctxOf(posed(), recorded);
		const r = await improviseConcludeTool(createImproviseGate(ctx), ctx).execute("call_c", { outcome: "fail", verdict: "x" } as never);
		assert.equal(r.isError, true);
		assert.match(problemsOf(r)[0]!, /surrendered/);
		assert.equal(recorded.length, 0);
	});

	it("surrendered records nothing (owner: a give-up is no judgment)", async () => {
		const recorded: ImprovisationJudgment[] = [];
		const ctx = ctxOf(attempted(), recorded);
		const r = await improviseConcludeTool(createImproviseGate(ctx), ctx).execute("call_c", { outcome: "surrendered", verdict: "Gave up." } as never);
		assert.equal(r.isError, undefined);
		assert.equal(recorded.length, 0);
		assert.deepEqual(r.details, { judgment: null });
	});

	it("with the graph off (no writer) it judges, records nothing, and says so", async () => {
		const ctx = ctxOf(attempted());
		const r = await improviseConcludeTool(createImproviseGate(ctx), ctx).execute("call_c", { outcome: "pass", verdict: "ok" } as never);
		assert.equal(r.isError, undefined);
		assert.match((r.content[0] as { text: string }).text, /not recorded/);
		assert.deepEqual(r.details, { judgment: null });
	});

	it("is rejected with nothing active", async () => {
		const ctx = ctxOf([], []);
		const r = await improviseConcludeTool(createImproviseGate(ctx), ctx).execute("call_c", { outcome: "pass", verdict: "x" } as never);
		assert.equal(r.isError, true);
	});
});

// ── rejudge ──────────────────────────────────────────────────────────────────

describe("rejudge — the contest channel", () => {
	const judged = (): ImprovisationJudgment => ({
		id: "impr_original",
		nodeIds: ["n_oppcost"],
		move: "context-shift",
		medium: "speech",
		challenge: POSE.statement,
		attempt: "Recess is the resource.",
		verdict: "fail",
		rationale: "No forced choice.",
		provenance: { chatId: "chat_gym", messageId: "msg_t1" },
		at: "2026-10-30T10:00:00.000Z",
	});
	/** A judged-and-concluded record, then the learner's contest message. */
	function contested(): LhMessage[] {
		return [
			...attempted(),
			assistant("msg_a2", "call_c1", PRACTICE_CONCLUDE_TOOL, { outcome: "fail", verdict: "No forced choice." }),
			result("msg_r2", "call_c1", PRACTICE_CONCLUDE_TOOL, { judgment: judged() }),
			{ id: "msg_u1", role: "user", content: "But tag vs swings IS the forced choice.", timestamp: 3 } as LhMessage,
		];
	}
	const CONTEST = { contest: "But tag vs swings IS the forced choice.", verdict: "pass", rationale: "Misread: the choice is there." } as const;

	it("records a revising judgment — same attempt, same clock, the contest verbatim", async () => {
		const recorded: ImprovisationJudgment[] = [];
		const ctx = ctxOf(contested(), recorded);
		const r = await rejudgeTool(createImproviseGate(ctx), ctx).execute("call_j", CONTEST as never);
		assert.equal(r.isError, undefined);
		const j = recorded[0]!;
		assert.notEqual(j.id, "impr_original");
		assert.deepEqual(
			{ ...j, id: "" },
			{
				...judged(),
				id: "",
				verdict: "pass",
				rationale: CONTEST.rationale,
				provenance: { chatId: "chat_gym", messageId: "msg_u1" },
				revises: "impr_original",
				contest: CONTEST.contest,
			},
		);
	});

	it("an upheld contest is recorded too — and derives the identical standing", async () => {
		const recorded: ImprovisationJudgment[] = [];
		const ctx = ctxOf(contested(), recorded);
		const r = await rejudgeTool(createImproviseGate(ctx), ctx).execute("call_j", { ...CONTEST, verdict: "fail" } as never);
		assert.equal(r.isError, undefined);
		assert.match((r.content[0] as { text: string }).text, /upheld/);
		assert.equal(recorded[0]!.revises, "impr_original");
		assert.equal(recorded[0]!.contest, CONTEST.contest);
		const now = new Date("2026-11-01T00:00:00.000Z");
		assert.deepEqual(deriveStandings([judged(), recorded[0]!], now), deriveStandings([judged()], now));
	});

	it("a second contest in the same turn revises the revision", async () => {
		const recorded: ImprovisationJudgment[] = [];
		const ctx = ctxOf(contested(), recorded);
		const tool = rejudgeTool(createImproviseGate(ctx), ctx);
		await tool.execute("call_j1", CONTEST as never);
		await tool.execute("call_j2", { ...CONTEST, verdict: "fail" } as never);
		assert.equal(recorded[1]!.revises, recorded[0]!.id);
	});

	it("nothing to contest: while a challenge is active, after a surrender, or on a fresh record", async () => {
		const surrendered = [
			...contested().slice(0, -1),
			...posed().map((m) => ({ ...m, id: `${m.id}_2` })) as LhMessage[],
			assistant("msg_a3", "call_c2", PRACTICE_CONCLUDE_TOOL, { outcome: "surrendered", verdict: "x" }),
			result("msg_r3", "call_c2", PRACTICE_CONCLUDE_TOOL, { judgment: null }),
		];
		for (const messages of [attempted(), surrendered, []]) {
			const ctx = ctxOf(messages, []);
			const r = await rejudgeTool(createImproviseGate(ctx), ctx).execute("call_j", CONTEST as never);
			assert.equal(r.isError, true);
			assert.match(problemsOf(r)[0]!, /nothing to rejudge/);
		}
	});
});

// ── registry, prompt, kind plumbing ──────────────────────────────────────────

describe("the improvise agent", () => {
	it("registry: problem + conclude + rejudge and practice's side tools — no question or plan tools", () => {
		const names = Object.keys(improviseTools(ctxOf([]))).sort();
		assert.deepEqual(names, ["conclude", "find", "grep", "ls", "problem", "read", "rejudge"]);
		assert.ok(createImproviseAgent(ctxOf([]), { engine: { model: { provider: "test", id: "m" }, level: "off", streamFn: (() => {}) as never } as never }));
	});

	it("composes its own directory plus the curated shared appendix — no teaching base", () => {
		const prompt = composeInstructions("improvise");
		assert.match(prompt, /isolate.*integrate.*improvise/is);
		assert.match(prompt, /`rejudge`/);
		assert.ok(!composeInstructions("improvise").includes(composeInstructions("teacher").slice(0, 200)));
		assert.ok(allSegmentPaths().includes("improvise/10-doctrine.md"));
	});

	it("is a problem-session kind: the next signal is allowed, teach still refuses it", () => {
		assert.equal(isProblemSessionKind("improvise"), true);
		assert.equal(isProblemSessionKind("practice"), true);
		assert.equal(isProblemSessionKind("teach"), false);
		assert.equal(isProblemSessionKind(undefined), false);
		const concluded = [
			...attempted(),
			assistant("msg_a2", "call_c1", PRACTICE_CONCLUDE_TOOL, { outcome: "pass", verdict: "ok" }),
			result("msg_r2", "call_c1", PRACTICE_CONCLUDE_TOOL),
		];
		assert.equal(inputAppends({ messages: concluded, kind: "improvise" }, { type: "next" }).length, 1);
	});

	it("the conclude card's reveal is the committed criteria", () => {
		const messages = [...attempted(), assistant("msg_a2", "call_c1", PRACTICE_CONCLUDE_TOOL, { outcome: "pass", verdict: "ok" })];
		assert.equal(modelSolutionForConclude(messages, "call_c1"), POSE.criteria);
	});
});
