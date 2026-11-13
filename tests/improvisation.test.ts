/**
 * Idea standings (core/improvisation.ts — cognitive-gym reorg, owner
 * 2026-10-30): the provisional/solid tier derived from improvisation
 * judgments. Pure — no ledgers, the clock is passed in.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ImprovisationJudgment } from "../src/core/contracts.ts";
import { ideaKindOf } from "../src/core/contracts.ts";
import {
	SOLID_LADDER_DAYS,
	UNJUDGED_STANDING,
	deriveStandings,
	effectiveJudgments,
	standingOf,
} from "../src/core/improvisation.ts";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const day = (n: number): Date => new Date(T0 + n * 24 * 60 * 60 * 1000);
const iso = (n: number): string => day(n).toISOString();

let seq = 0;
function judgment(over: Partial<ImprovisationJudgment> & Pick<ImprovisationJudgment, "verdict" | "at">): ImprovisationJudgment {
	seq += 1;
	return {
		id: `j${seq}`,
		nodeIds: ["n_a"],
		move: "context-shift",
		challenge: "Use it somewhere new.",
		attempt: "An attempt.",
		rationale: "Because.",
		provenance: { chatId: "chat_gym", messageId: `m${seq}` },
		...over,
	};
}

describe("deriveStandings — the ladder", () => {
	it("an unjudged idea is provisional at rung 0", () => {
		const standings = deriveStandings([], day(0));
		assert.deepEqual(standingOf(standings, "n_a"), UNJUDGED_STANDING);
		assert.equal(UNJUDGED_STANDING.tier, "provisional");
	});

	it("a pass makes the idea solid for the first rung, then it expires to provisional", () => {
		const lines = [judgment({ verdict: "pass", at: iso(0) })];
		const during = standingOf(deriveStandings(lines, day(2)), "n_a");
		assert.deepEqual(during, { tier: "solid", rung: 1, solidUntil: iso(SOLID_LADDER_DAYS[0]), lastJudgedAt: iso(0) });
		const after = standingOf(deriveStandings(lines, day(SOLID_LADDER_DAYS[0])), "n_a");
		assert.equal(after.tier, "provisional", "the period's end is exclusive");
		assert.equal(after.rung, 1, "the lapsed-from rung shows until the next pass");
	});

	it("each pass climbs a rung (3 → 7 → 21 → 60 days) and the top rung caps", () => {
		const lines = [0, 2, 8, 28, 80].map((d) => judgment({ verdict: "pass", at: iso(d) }));
		const standing = standingOf(deriveStandings(lines, day(81)), "n_a");
		assert.equal(standing.rung, SOLID_LADDER_DAYS.length, "capped at the top rung");
		assert.equal(standing.solidUntil, iso(80 + SOLID_LADDER_DAYS[SOLID_LADDER_DAYS.length - 1]!));
		assert.deepEqual([...SOLID_LADDER_DAYS], [3, 7, 21, 60]);
	});

	it("expiry costs one rung: the next pass re-earns the period it lapsed from", () => {
		const lines = [0, 2, 8].map((d) => judgment({ verdict: "pass", at: iso(d) }));
		assert.equal(standingOf(deriveStandings(lines, day(9)), "n_a").rung, 3, "rung 3: solid until day 29");
		const relapsed = [...lines, judgment({ verdict: "pass", at: iso(40) })];
		const standing = standingOf(deriveStandings(relapsed, day(41)), "n_a");
		assert.equal(standing.rung, 3);
		assert.equal(standing.solidUntil, iso(40 + SOLID_LADDER_DAYS[2]));
	});

	it("at most one climb per day: a sooner pass keeps the rung and restarts its period", () => {
		const hour = 60 * 60 * 1000;
		const at = (ms: number) => new Date(T0 + ms).toISOString();
		const sameDay = [0, 1, 2].map((h) => judgment({ verdict: "pass", at: at(h * hour) }));
		const standing = standingOf(deriveStandings(sameDay, day(1)), "n_a");
		assert.equal(standing.rung, 1);
		assert.equal(standing.solidUntil, new Date(T0 + 2 * hour + SOLID_LADDER_DAYS[0] * 24 * hour).toISOString());
		const nextDay = [...sameDay, judgment({ verdict: "pass", at: iso(1) })];
		assert.equal(standingOf(deriveStandings(nextDay, day(1)), "n_a").rung, 2, "24h after the last CLIMB, not the last pass");
	});

	it("after a fail, the next pass climbs to the first rung even within the day", () => {
		const lines = [
			judgment({ verdict: "pass", at: iso(0) }),
			judgment({ verdict: "fail", at: new Date(T0 + 60_000).toISOString() }),
			judgment({ verdict: "pass", at: new Date(T0 + 120_000).toISOString() }),
		];
		const standing = standingOf(deriveStandings(lines, day(1)), "n_a");
		assert.equal(standing.tier, "solid");
		assert.equal(standing.rung, 1);
	});

	it("a fail resets to the bottom: provisional now, the next pass earns the first rung", () => {
		const lines = [
			judgment({ verdict: "pass", at: iso(0) }),
			judgment({ verdict: "pass", at: iso(2) }),
			judgment({ verdict: "fail", at: iso(4) }),
		];
		const failed = standingOf(deriveStandings(lines, day(5)), "n_a");
		assert.deepEqual(failed, { tier: "provisional", rung: 0, solidUntil: null, lastJudgedAt: iso(4) });
		const again = standingOf(deriveStandings([...lines, judgment({ verdict: "pass", at: iso(6) })], day(7)), "n_a");
		assert.equal(again.rung, 1);
		assert.equal(again.solidUntil, iso(6 + SOLID_LADDER_DAYS[0]));
	});

	it("applies judgments in time order, not append order (ties keep append order)", () => {
		const lines = [judgment({ verdict: "fail", at: iso(5) }), judgment({ verdict: "pass", at: iso(1) })];
		assert.equal(standingOf(deriveStandings(lines, day(2)), "n_a").tier, "provisional", "the later fail wins");
		const tied = [judgment({ verdict: "pass", at: iso(1) }), judgment({ verdict: "fail", at: iso(1) })];
		assert.equal(standingOf(deriveStandings(tied, day(2)), "n_a").rung, 0);
	});

	it("one judgment of several nodes moves each of them, independently of their other history", () => {
		const lines = [
			judgment({ verdict: "pass", at: iso(0), nodeIds: ["n_a"] }),
			judgment({ verdict: "pass", at: iso(1), nodeIds: ["n_a", "n_b", "n_b"] }),
		];
		const standings = deriveStandings(lines, day(2));
		assert.equal(standingOf(standings, "n_a").rung, 2);
		assert.equal(standingOf(standings, "n_b").rung, 1, "a repeated id counts once");
	});
});

describe("contests — re-examinations revise, never edit", () => {
	it("a revising judgment replaces the one it names", () => {
		const failed = judgment({ verdict: "fail", at: iso(0) });
		const upheld = judgment({ verdict: "pass", at: iso(0), revises: failed.id, contest: "It was a context shift." });
		assert.deepEqual(effectiveJudgments([failed, upheld]), [upheld]);
		assert.equal(standingOf(deriveStandings([failed, upheld], day(1)), "n_a").tier, "solid");
	});

	it("chains of revisions resolve to the last", () => {
		const first = judgment({ verdict: "fail", at: iso(0) });
		const second = judgment({ verdict: "pass", at: iso(0), revises: first.id });
		const third = judgment({ verdict: "fail", at: iso(0), revises: second.id });
		assert.deepEqual(effectiveJudgments([first, second, third]), [third]);
	});
});

describe("ideaKindOf", () => {
	it("an absent kind (every pre-reorg node) reads as a proposition", () => {
		assert.equal(ideaKindOf({}), "proposition");
		assert.equal(ideaKindOf({ kind: "awareness-experiment" }), "awareness-experiment");
	});
});
