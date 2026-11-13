/**
 * Idea standings — the provisional/solid tier, DERIVED on read from the
 * improvisation judgments (cognitive-gym reorg, owner 2026-10-30; Ido
 * Portal's isolate → integrate → improvise).
 *
 * An idea enters the graph PROVISIONAL (isolated + integrated by teaching
 * and extraction). It becomes SOLID only when the learner improvises with
 * it — uses it creatively in a different context, or tries a slightly
 * differing idea in the same place — and the AI judge passes the attempt.
 * Solid is not forever: the cognitive gym exists so skills do not decay.
 *
 *   pass   climbs one rung of the ladder (capped at the top rung) and
 *          makes the idea solid for that rung's period, from the
 *          judgment's time. At most ONE climb per idea per day (owner,
 *          2026-10-30 — a rolling 24h since the last climb, so the pure
 *          core needs no timezone): a sooner pass keeps the rung and
 *          restarts its period instead of advancing it
 *   fail   resets to the bottom (owner, 2026-10-30): provisional NOW, and
 *          the next pass earns the first rung again
 *   expiry a solid idea whose period has run out reads provisional and
 *          costs one rung (owner, 2026-10-30): the next pass re-earns the
 *          period it lapsed from
 *
 * Contests are re-examinations, not edits: a judgment whose id a later
 * judgment `revises` is ignored (chains of revisions resolve to the last).
 *
 * Pure and browser-safe: no IO, no clock of its own — the caller passes
 * `now`. A standing describes the idea's place in the graph, never a
 * rating of the learner. Nothing here is stored.
 */

import type { ImprovisationJudgment } from "./contracts.ts";

/** The solid periods, in days, one per rung (owner, 2026-10-30). */
export const SOLID_LADDER_DAYS = [3, 7, 21, 60] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type IdeaTier = "provisional" | "solid";

export interface IdeaStanding {
	tier: IdeaTier;
	/** Ladder position: 0 = no standing pass since the last fail (or ever);
	 *  n = the nth rung (SOLID_LADDER_DAYS[n - 1] days). An expired idea
	 *  shows the rung it lapsed from; the next pass applies the cost. */
	rung: number;
	/** ISO — when the current solid period ends; null when no pass stands. */
	solidUntil: string | null;
	/** ISO — the latest effective judgment's time; null when never judged. */
	lastJudgedAt: string | null;
}

/** The standing of an idea no judgment has touched. */
export const UNJUDGED_STANDING: IdeaStanding = {
	tier: "provisional",
	rung: 0,
	solidUntil: null,
	lastJudgedAt: null,
};

/** The judgments that still count: every line no later line revises.
 *  Append order is preserved. */
export function effectiveJudgments(lines: ReadonlyArray<ImprovisationJudgment>): ImprovisationJudgment[] {
	const revised = new Set<string>();
	for (const line of lines) {
		if (line.revises !== undefined) revised.add(line.revises);
	}
	return lines.filter((line) => !revised.has(line.id));
}

/**
 * Every judged idea's standing at `now`, keyed by node id. Ideas absent
 * from the map are UNJUDGED_STANDING (standingOf). Judgments apply in time
 * order (`at`; ties keep append order); a judgment of several nodes moves
 * each of them.
 */
export function deriveStandings(
	lines: ReadonlyArray<ImprovisationJudgment>,
	now: Date,
): Map<string, IdeaStanding> {
	const ordered = effectiveJudgments(lines)
		.map((line, index) => ({ line, index, time: Date.parse(line.at) }))
		.sort((a, b) => a.time - b.time || a.index - b.index);

	const ladder = new Map<string, LadderState>();
	for (const { line, time } of ordered) {
		for (const nodeId of new Set(line.nodeIds)) {
			ladder.set(nodeId, line.verdict === "pass" ? afterPass(ladder.get(nodeId), time) : afterFail(time));
		}
	}

	const nowMs = now.getTime();
	const out = new Map<string, IdeaStanding>();
	for (const [nodeId, state] of ladder) {
		out.set(nodeId, {
			tier: state.solidUntilMs !== null && state.solidUntilMs > nowMs ? "solid" : "provisional",
			rung: state.rung,
			solidUntil: state.solidUntilMs === null ? null : new Date(state.solidUntilMs).toISOString(),
			lastJudgedAt: new Date(state.lastMs).toISOString(),
		});
	}
	return out;
}

/** One idea's ladder while folding judgments (times in epoch ms). */
interface LadderState {
	rung: number;
	solidUntilMs: number | null;
	lastMs: number;
	/** The last pass that climbed — null after a fail (or never). */
	lastClimbMs: number | null;
}

function afterPass(prev: LadderState | undefined, time: number): LadderState {
	const lapsed = prev !== undefined && prev.solidUntilMs !== null && prev.solidUntilMs <= time;
	const base = lapsed ? prev.rung - 1 : (prev?.rung ?? 0);
	const climbs = prev?.lastClimbMs == null || time - prev.lastClimbMs >= DAY_MS;
	// No climb ⇒ a climb landed within the day and no fail since, so the
	// idea is solid at base ≥ 1 (a climb's period outlasts a day).
	const rung = climbs ? Math.min(base + 1, SOLID_LADDER_DAYS.length) : base;
	return {
		rung,
		solidUntilMs: time + SOLID_LADDER_DAYS[rung - 1]! * DAY_MS,
		lastMs: time,
		lastClimbMs: climbs ? time : prev!.lastClimbMs,
	};
}

function afterFail(time: number): LadderState {
	return { rung: 0, solidUntilMs: null, lastMs: time, lastClimbMs: null };
}

/** One idea's standing from a deriveStandings map (unjudged → provisional). */
export function standingOf(standings: ReadonlyMap<string, IdeaStanding>, nodeId: string): IdeaStanding {
	return standings.get(nodeId) ?? UNJUDGED_STANDING;
}
