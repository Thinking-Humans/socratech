/**
 * THE GYM'S MCP SERVER (Claude integration, owner 2026-10-30): the
 * cognitive gym exposed to the user's own Claude clients (Claude Code,
 * Desktop, claude.ai — on their Claude subscription) over streamable HTTP
 * at /api/mcp, inside the app process so the graph keeps ONE writer
 * process. Claude can read ideas and their standings, act as the
 * improvisation judge (record + contest judgments), and add ideas.
 *
 * Writes go through the same seams the app uses: judgments append to the
 * improvisation ledger; ideas go through the deterministic merger
 * (core/graph.ts mergeFindings) under one notes-style source id, so the
 * detail card shows "Claude (MCP)" as their provenance. Stateless: one
 * server + transport per request (no MCP session to leak).
 *
 * Access: the proxy admits /api/mcp only with its bearer token
 * (mcp-access.ts); handleMcpRequest additionally refuses non-loopback
 * Host headers (DNS-rebinding belt).
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { PATHS } from "../../config.ts";
import { formatChainLine, resolveTargetId } from "../core/chains.ts";
import {
	IDEA_KINDS,
	IMPROVISATION_MEDIA,
	IMPROVISATION_MOVES,
	ideaKindOf,
	type GraphNode,
	type ImprovisationJudgment,
} from "../core/contracts/graph.ts";
import { getGraph, mergeFindings, type GraphDeps } from "../core/graph.ts";
import { deriveStandings, effectiveJudgments, standingOf, type IdeaStanding } from "../core/improvisation.ts";
import { settleGraphLayout } from "../core/layout-settle.ts";
import { stores } from "./stores.ts";
import { clipPage } from "./web-clip.ts";

/** The provenance source every Claude-made write carries (a notes-style
 *  source id: the snapshot resolves it to SOURCE_LABEL). */
export const CLAUDE_SOURCE_ID = "src_claude_mcp";
const SOURCE_LABEL = "Claude (MCP)";

const DOCTRINE_FILE = path.join(PATHS.root, "src", "agent", "prompts", "improvise", "10-doctrine.md");

type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (body: string): Text => ({ content: [{ type: "text", text: body }] });
const refuse = (body: string): Text => ({ content: [{ type: "text", text: body }], isError: true });

const day = (iso: string) => iso.slice(0, 10);

function standingLine(s: IdeaStanding): string {
	if (s.tier === "solid") return `solid until ${day(s.solidUntil!)} (rung ${s.rung})`;
	if (s.lastJudgedAt === null) return "provisional (never improvised)";
	if (s.rung > 0) return `provisional (lapsed from rung ${s.rung})`;
	return "provisional (last attempt failed)";
}

/** The MCP-facing mechanics, prepended to the improvise doctrine. */
const MECHANICS = `You are coaching an improvisation session in the learner's cognitive gym (LearnHarness), through its MCP tools. The learner is talking to you directly — there is no challenge panel; challenges and attempts are ordinary conversation.

The loop:
1. Find ideas to play with: list_ideas (provisional ideas, and solid ones nearing expiry, first), get_idea for detail. Only ever challenge ideas that exist in the map.
2. Before posing, write your criteria privately — what a passing attempt must preserve or show. Do not show them yet.
3. Pose ONE challenge: a move (context-shift or variant) and a medium (text, speech, rap — lyrics to a beat — or moodboard — images that carry the idea's aesthetic).
4. When the learner gives a real attempt, judge it against your criteria and call record_improvisation (pass or fail) — then reveal the criteria. If the learner gives up, record nothing.
5. If the learner contests a verdict, re-examine honestly and call rejudge_improvisation — for every contest, upheld or changed.
6. add_idea saves a new idea the learner brings (check list_ideas first; use sameAs when it is a rewording of an existing idea).

The method follows.`;

export interface GymMcpDeps extends GraphDeps {
	now?: () => Date;
}

/** Build the gym's MCP server over the given stores (tests inject). */
export function createGymMcpServer(deps: GymMcpDeps = stores): McpServer {
	const { graphStore } = deps;
	const now = deps.now ?? (() => new Date());
	const server = new McpServer({ name: "learnharness-gym", version: "1.0.0" });

	const nodesById = (): Map<string, GraphNode> => new Map(getGraph(graphStore).nodes.map((n) => [n.id, n]));
	const standings = () => deriveStandings(graphStore.readImprovisations(), now());

	server.registerTool(
		"list_ideas",
		{
			description:
				"List the ideas in the learner's knowledge graph with their improvisation standing (provisional, or solid " +
				"until a date). Provisional ideas come first, then solid ones by soonest expiry.",
			inputSchema: {
				tier: z.enum(["provisional", "solid", "all"]).optional().describe("Filter by standing (default all)."),
				kind: z.enum(IDEA_KINDS).optional().describe("Filter by idea kind."),
				query: z.string().optional().describe("Case-insensitive text to match in name, statement, or phrasings."),
				limit: z.number().int().min(1).max(500).optional().describe("Maximum ideas to return (default 50)."),
			},
		},
		async ({ tier = "all", kind, query, limit = 50 }) => {
			const all = standings();
			const q = query?.toLowerCase();
			const rows = [...nodesById().values()]
				.filter((n) => kind === undefined || ideaKindOf(n) === kind)
				.filter((n) => !q || [n.name, n.statement, ...n.aliases].some((t) => t.toLowerCase().includes(q)))
				.map((n) => ({ n, s: standingOf(all, n.id) }))
				.filter(({ s }) => tier === "all" || s.tier === tier)
				.sort((a, b) =>
					a.s.tier !== b.s.tier
						? a.s.tier === "provisional" ? -1 : 1
						: (a.s.solidUntil ?? "").localeCompare(b.s.solidUntil ?? "") || a.n.name.localeCompare(b.n.name),
				);
			if (rows.length === 0) return text("No ideas match.");
			const lines = rows.slice(0, limit).map(({ n, s }) => `[${n.id}] ${n.name} (${ideaKindOf(n)}) — ${standingLine(s)}`);
			const more = rows.length > limit ? `\n…and ${rows.length - limit} more (raise limit or narrow the query).` : "";
			return text(`${rows.length} idea(s):\n${lines.join("\n")}${more}`);
		},
	);

	server.registerTool(
		"get_idea",
		{
			description: "One idea in full: its statement, kind, standing, the reasoning chains it sits in, and its improvisation history.",
			inputSchema: { id: z.string().describe("The idea id (from list_ideas) or its exact name.") },
		},
		async ({ id }) => {
			const graph = getGraph(graphStore);
			const resolved = resolveTargetId(id, graph.nodes);
			const node = resolved === null ? undefined : graph.nodes.find((n) => n.id === resolved);
			if (!node) return refuse(`No idea "${id}" in the map — use list_ideas.`);
			const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
			const chains = graph.chains
				.filter((c) => c.conclusion === node.id || c.premises.includes(node.id))
				.map((c) => `- ${formatChainLine(c, byId)}`);
			const lines = graphStore.readImprovisations();
			const effective = new Set(effectiveJudgments(lines).map((j) => j.id));
			const history = lines
				.filter((j) => j.nodeIds.includes(node.id))
				.map(
					(j) =>
						`- ${day(j.at)} ${j.verdict.toUpperCase()} · ${j.move} · ${j.medium ?? "text"}${effective.has(j.id) ? "" : " (revised)"}` +
						`${j.revises ? " (contest re-examination)" : ""} [${j.id}]\n  challenge: ${j.challenge}\n  rationale: ${j.rationale}`,
				);
			return text(
				[
					`[${node.id}] ${node.name} (${ideaKindOf(node)})`,
					node.statement,
					`Standing: ${standingLine(standingOf(standings(), node.id))}`,
					`Chains:\n${chains.length > 0 ? chains.join("\n") : "- none"}`,
					`Improvisations:\n${history.length > 0 ? history.join("\n") : "- none yet"}`,
				].join("\n\n"),
			);
		},
	);

	server.registerTool(
		"record_improvisation",
		{
			description:
				"Record your judgment of ONE real improvisation attempt (pass or fail) for the idea(s) it exercised. " +
				"This moves each idea's standing. Never record an attempt the learner did not make.",
			inputSchema: {
				ideaIds: z.array(z.string()).min(1).describe("The idea ids (or exact names) the challenge exercised."),
				move: z.enum(IMPROVISATION_MOVES),
				medium: z.enum(IMPROVISATION_MEDIA),
				challenge: z.string().min(1).describe("The challenge as you posed it."),
				attempt: z.string().min(1).describe("The learner's attempt, verbatim (for a moodboard: describe the images)."),
				verdict: z.enum(["pass", "fail"]),
				rationale: z.string().min(1).describe("Your judgment against the criteria."),
			},
		},
		async (input) => {
			const nodes = getGraph(graphStore).nodes;
			const ids = input.ideaIds.map((t) => resolveTargetId(t, nodes));
			const unknown = input.ideaIds.filter((_, i) => ids[i] === null);
			if (unknown.length > 0) return refuse(`Not ideas in the map: ${JSON.stringify(unknown)} — use list_ideas.`);
			const judgment: ImprovisationJudgment = {
				id: newJudgmentId(),
				nodeIds: [...new Set(ids as string[])],
				move: input.move,
				medium: input.medium,
				challenge: input.challenge,
				attempt: input.attempt,
				verdict: input.verdict,
				rationale: input.rationale,
				provenance: { chatId: CLAUDE_SOURCE_ID, messageId: "" },
				at: now().toISOString(),
			};
			graphStore.appendImprovisation(judgment);
			return text(`Recorded [${judgment.id}].\n${standingsReport(judgment.nodeIds)}`);
		},
	);

	server.registerTool(
		"rejudge_improvisation",
		{
			description:
				"Record the re-examination of a contested judgment — for every contest, upheld (same verdict) or changed. " +
				"The original stays as history; the idea's clock does not move.",
			inputSchema: {
				judgmentId: z.string().describe("The judgment being contested (from record_improvisation or get_idea)."),
				contest: z.string().min(1).describe("The learner's contest, verbatim."),
				verdict: z.enum(["pass", "fail"]).describe("The re-examined verdict."),
				rationale: z.string().min(1).describe("Why the verdict stands or changes, against the same criteria."),
			},
		},
		async (input) => {
			const lines = graphStore.readImprovisations();
			const prev = effectiveJudgments(lines).find((j) => j.id === input.judgmentId);
			if (!prev) {
				const revised = lines.some((j) => j.id === input.judgmentId);
				return refuse(
					revised
						? `[${input.judgmentId}] was already re-examined — contest its latest revision (see get_idea).`
						: `No judgment [${input.judgmentId}].`,
				);
			}
			const judgment: ImprovisationJudgment = {
				...prev,
				id: newJudgmentId(),
				verdict: input.verdict,
				rationale: input.rationale,
				provenance: { chatId: CLAUDE_SOURCE_ID, messageId: "" },
				revises: prev.id,
				contest: input.contest,
			};
			graphStore.appendImprovisation(judgment);
			const outcome = input.verdict === prev.verdict ? "Upheld" : `Changed to ${input.verdict}`;
			return text(`${outcome} — recorded [${judgment.id}].\n${standingsReport(judgment.nodeIds)}`);
		},
	);

	server.registerTool(
		"add_idea",
		{
			description:
				"Add an idea to the learner's map (it starts provisional). Check list_ideas first: when the idea is a " +
				"rewording of an existing one, pass sameAs — the phrasing joins that idea instead of duplicating it.",
			inputSchema: {
				name: z.string().min(1).describe("A very short label, like a glossary headword."),
				statement: z
					.string()
					.min(1)
					.describe("The idea at full precision: one true, self-contained claim — or, for an awareness experiment, what is done and what is attended to."),
				kind: z.enum(IDEA_KINDS).optional().describe("Default proposition."),
				sameAs: z.string().optional().describe("An existing idea id this IS (a rewording)."),
			},
		},
		async (input) => {
			const nodes = nodesById();
			if (input.sameAs !== undefined && !nodes.has(input.sameAs)) {
				return refuse(`No idea [${input.sameAs}] — omit sameAs to create a new one.`);
			}
			const before = new Set(nodes.keys());
			const at = now().toISOString();
			graphStore.upsertSource({ id: CLAUDE_SOURCE_ID, filePath: SOURCE_LABEL, importedAt: at });
			mergeFindings(
				CLAUDE_SOURCE_ID,
				{
					propositions: [
						{
							id: "p1",
							name: input.name,
							statement: input.statement,
							aliases: [],
							...(input.kind !== undefined && input.kind !== "proposition" ? { kind: input.kind } : {}),
						},
					],
					chains: [],
				},
				{ links: input.sameAs !== undefined ? [{ id: "p1", linkTo: input.sameAs }] : [] },
				deps,
				{ foldedAt: at },
			);
			settleGraphLayout(graphStore);
			if (input.sameAs !== undefined) return text(`Linked to [${input.sameAs}] — the phrasing joined it.`);
			const created = getGraph(graphStore).nodes.find((n) => !before.has(n.id));
			return text(`Added [${created?.id ?? "?"}] ${input.name} — provisional until improvised.`);
		},
	);

	server.registerTool(
		"import_page_as_notebook",
		{
			description:
				"Clip a web page into the learner's vault as a new notebook (docs/web-clip.md): the page's sections become " +
				"private cells with a source link, its code blocks runnable code cells, and exercise cells follow each " +
				"section shortly after (written in the background). Pass the page's html or markdown when you have it " +
				"(logged-in or JavaScript-rendered pages); with only a url the app fetches the page itself.",
			inputSchema: {
				url: z.string().url().describe("The page's address (http or https)."),
				title: z.string().optional().describe("The notebook title. Default: the page's title."),
				html: z.string().optional().describe("The page (or its article) as HTML."),
				markdown: z.string().optional().describe("The page as markdown. Wins over html."),
			},
		},
		async (input) => {
			try {
				const { journal, exercises } = await clipPage(input);
				const note =
					exercises === "queued"
						? "Exercise cells are being written now."
						: exercises === "no-model"
							? "No exercises: no strong model is set (Settings → Models)."
							: "No exercises: the page had no sections.";
				return text(
					JSON.stringify({ id: journal.id, title: journal.title, path: `/notebook/${journal.id}`, cells: journal.cells.length, exercises }) +
						`\nAdded notebook "${journal.title}" (${journal.cells.length} cells). ${note}`,
				);
			} catch (err) {
				return refuse(err instanceof Error ? err.message : String(err));
			}
		},
	);

	server.registerPrompt(
		"improvise",
		{
			description: "Run an improvisation session in the cognitive gym (Ido Portal's isolate → integrate → improvise).",
			argsSchema: { focus: z.string().optional().describe("A topic or idea to start with (optional).") },
		},
		({ focus }) => {
			let doctrine = "";
			try {
				doctrine = fs.readFileSync(DOCTRINE_FILE, "utf-8");
			} catch {
				// The doctrine ships with the app; a missing file leaves the mechanics.
			}
			const start = focus ? `\n\nStart with: ${focus}` : "\n\nStart by finding provisional ideas with list_ideas.";
			return {
				messages: [{ role: "user", content: { type: "text", text: `${MECHANICS}\n\n${doctrine}${start}` } }],
			};
		},
	);

	function standingsReport(nodeIds: string[]): string {
		const all = standings();
		const names = nodesById();
		return nodeIds.map((id) => `- ${names.get(id)?.name ?? id}: ${standingLine(standingOf(all, id))}`).join("\n");
	}

	return server;
}

/** "impr_" + 12 hex chars — the judgment id pattern (tools/improvise.ts). */
function newJudgmentId(): string {
	return `impr_${randomBytes(6).toString("hex")}`;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Serve one MCP request (the /api/mcp route). The proxy already checked
 *  the bearer token; this refuses non-loopback Host headers. */
export async function handleMcpRequest(request: Request): Promise<Response> {
	const host = request.headers.get("host") ?? "";
	const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
	if (!LOOPBACK_HOSTS.has(hostname)) {
		return Response.json({ error: "The MCP endpoint answers loopback hosts only." }, { status: 403 });
	}
	const server = createGymMcpServer();
	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	await server.connect(transport);
	try {
		return await transport.handleRequest(request);
	} finally {
		void server.close();
	}
}
