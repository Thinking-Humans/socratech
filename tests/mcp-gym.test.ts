/**
 * THE GYM'S MCP SERVER (Claude integration, owner 2026-10-30): a real MCP
 * client over an in-memory transport against in-memory ledgers — the
 * tools' reads (standings, history), writes (judgments, contests, ideas)
 * and refusals; plus the endpoint's guards (bearer token, loopback host).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { GraphChain, GraphNode, ImprovisationJudgment, NotesSource } from "../src/core/contracts/graph.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import { CLAUDE_SOURCE_ID, createGymMcpServer, handleMcpRequest } from "../src/server/mcp.ts";
import { mcpAuthorized } from "../src/server/mcp-access.ts";
import { claudeMcpAddCommand } from "../components/settings/claude-section.tsx";

const NOW = new Date("2026-10-30T12:00:00.000Z");

function memoryGraph(seed: GraphNode[] = [], chains: GraphChain[] = []) {
	const nodes = [...seed];
	const judgments: ImprovisationJudgment[] = [];
	const sources = new Map<string, NotesSource>();
	let positions: Record<string, { x: number; y: number }> = {};
	const graphStore = {
		appendNode: (n: GraphNode) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n })),
		appendChain: (c: GraphChain) => void chains.push(c),
		readChains: () => [...chains],
		appendCheckpoint: () => {},
		readCheckpoints: () => [],
		appendCoverage: () => {},
		readCoverage: () => [],
		appendImprovisation: (j: ImprovisationJudgment) => void judgments.push(j),
		readImprovisations: () => [...judgments],
		upsertSource: (s: NotesSource) => void sources.set(s.id, s),
		readSources: () => [...sources.values()],
		deleteSources: (ids: Iterable<string>) => [...ids].reduce((n, id) => n + Number(sources.delete(id)), 0),
		appendSourceUsage: () => {},
		readPositions: () => positions,
		writePositions: (p: Record<string, { x: number; y: number }>) => void (positions = p),
		rewriteLedgers: () => {},
	} satisfies GraphStore;
	return { graphStore, nodes, judgments, sources };
}

const node = (id: string, name: string, kind?: GraphNode["kind"]): GraphNode => ({
	id,
	...(kind ? { kind } : {}),
	name,
	statement: `${name}, stated.`,
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [{ chatId: "chat_teach", messageId: "m1" }],
});

async function connect(mem: ReturnType<typeof memoryGraph>) {
	const server = createGymMcpServer({ graphStore: mem.graphStore, chatStore: {} as ChatStore, now: () => NOW });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "test", version: "0" });
	await client.connect(clientSide);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
		return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
	};
	return { client, call };
}

const JUDGE = {
	ideaIds: ["n_opp"],
	move: "context-shift",
	medium: "rap",
	challenge: "Rap opportunity cost over a boom-bap beat.",
	attempt: "Chose the mic, lost the swing, that's the price of the thing.",
	verdict: "pass",
	rationale: "The forgone alternative carried the hook.",
} as const;

describe("gym MCP — reads", () => {
	it("exposes the six tools and the improvise prompt", async () => {
		const { client } = await connect(memoryGraph());
		const tools = (await client.listTools()).tools.map((t) => t.name).sort();
		assert.deepEqual(tools, ["add_idea", "get_idea", "import_page_as_notebook", "list_ideas", "record_improvisation", "rejudge_improvisation"]);
		const prompt = await client.getPrompt({ name: "improvise", arguments: { focus: "opportunity cost" } });
		const body = (prompt.messages[0]!.content as { text: string }).text;
		assert.match(body, /record_improvisation/);
		assert.match(body, /isolate.*integrate.*improvise/is, "the improvise doctrine rides along");
		assert.match(body, /Start with: opportunity cost/);
	});

	it("list_ideas: provisional first, then solid by expiry; filters by tier, kind, query", async () => {
		const mem = memoryGraph([node("n_opp", "Opportunity cost"), node("n_breath", "Breath counting", "awareness-experiment"), node("n_sunk", "Sunk cost")]);
		const { call } = await connect(mem);
		await call("record_improvisation", JUDGE);
		const all = await call("list_ideas", {});
		assert.match(all.text, /^3 idea\(s\):/);
		assert.ok(all.text.indexOf("Sunk cost") < all.text.indexOf("Opportunity cost"), "provisional before solid");
		assert.match(all.text, /\[n_opp\] Opportunity cost \(proposition\) — solid until 2026-11-02 \(rung 1\)/);
		assert.match(all.text, /\[n_breath\] Breath counting \(awareness-experiment\) — provisional \(never improvised\)/);
		assert.doesNotMatch((await call("list_ideas", { tier: "provisional" })).text, /Opportunity/);
		assert.match((await call("list_ideas", { kind: "awareness-experiment" })).text, /^1 idea/);
		assert.equal((await call("list_ideas", { query: "nothing like it" })).text, "No ideas match.");
	});

	it("get_idea: statement, standing, chains and history — by id or exact name", async () => {
		const mem = memoryGraph(
			[node("n_opp", "Opportunity cost"), node("n_choice", "Scarcity forces choice")],
			[{ id: "arg_1", premises: ["n_choice"], conclusion: "n_opp", provenance: [], createdAt: "2026-10-01T00:00:00.000Z" }],
		);
		const { call } = await connect(mem);
		await call("record_improvisation", JUDGE);
		const r = await call("get_idea", { id: "Opportunity cost" });
		assert.equal(r.isError, false);
		assert.match(r.text, /Opportunity cost, stated\./);
		assert.match(r.text, /Standing: solid until 2026-11-02/);
		assert.match(r.text, /Scarcity forces choice/);
		assert.match(r.text, /2026-10-30 PASS · context-shift · rap/);
		assert.equal((await call("get_idea", { id: "n_missing" })).isError, true);
	});
});

describe("gym MCP — writes", () => {
	it("record_improvisation: one judgment, Claude's provenance, names resolve; unknown ideas refused", async () => {
		const mem = memoryGraph([node("n_opp", "Opportunity cost")]);
		const { call } = await connect(mem);
		const r = await call("record_improvisation", { ...JUDGE, ideaIds: ["Opportunity cost"] });
		assert.equal(r.isError, false);
		assert.equal(mem.judgments.length, 1);
		const j = mem.judgments[0]!;
		assert.deepEqual(j.nodeIds, ["n_opp"]);
		assert.equal(j.medium, "rap");
		assert.deepEqual(j.provenance, { chatId: CLAUDE_SOURCE_ID, messageId: "" });
		assert.equal(j.at, NOW.toISOString());
		const bad = await call("record_improvisation", { ...JUDGE, ideaIds: ["n_nope"] });
		assert.equal(bad.isError, true);
		assert.equal(mem.judgments.length, 1);
	});

	it("rejudge_improvisation: upheld or changed, revises the latest, keeps the clock; a revised one is refused", async () => {
		const mem = memoryGraph([node("n_opp", "Opportunity cost")]);
		const { call } = await connect(mem);
		await call("record_improvisation", { ...JUDGE, verdict: "fail" });
		const original = mem.judgments[0]!;
		const changed = await call("rejudge_improvisation", { judgmentId: original.id, contest: "The hook IS the trade-off.", verdict: "pass", rationale: "Misread." });
		assert.match(changed.text, /^Changed to pass/);
		const revision = mem.judgments[1]!;
		assert.equal(revision.revises, original.id);
		assert.equal(revision.at, original.at);
		assert.equal(revision.contest, "The hook IS the trade-off.");
		const stale = await call("rejudge_improvisation", { judgmentId: original.id, contest: "x", verdict: "fail", rationale: "y" });
		assert.equal(stale.isError, true);
		assert.match(stale.text, /already re-examined/);
		const upheld = await call("rejudge_improvisation", { judgmentId: revision.id, contest: "Again?", verdict: "pass", rationale: "Stands." });
		assert.match(upheld.text, /^Upheld/);
	});

	it("add_idea: creates a provisional idea with its kind and Claude's source; sameAs links instead", async () => {
		const mem = memoryGraph([node("n_opp", "Opportunity cost")]);
		const { call } = await connect(mem);
		const r = await call("add_idea", { name: "Noting", statement: "Label each sensation as it arises.", kind: "awareness-experiment" });
		assert.match(r.text, /^Added \[n_[0-9a-f]{12}\] Noting/);
		const created = mem.nodes.at(-1)!;
		assert.equal(created.kind, "awareness-experiment");
		assert.deepEqual(created.provenance, [{ chatId: CLAUDE_SOURCE_ID, messageId: "" }]);
		assert.equal(mem.sources.get(CLAUDE_SOURCE_ID)?.filePath, "Claude (MCP)");
		const linked = await call("add_idea", { name: "Opp cost", statement: "What you give up is the price.", sameAs: "n_opp" });
		assert.match(linked.text, /^Linked to \[n_opp\]/);
		assert.equal(mem.nodes.filter((n) => n.id === "n_opp").length, 2, "a link line, not a new node");
		assert.equal((await call("add_idea", { name: "x", statement: "y", sameAs: "n_nope" })).isError, true);
	});
});

describe("gym MCP — the endpoint's guards", () => {
	const TOKEN = "a".repeat(64);
	const headers = (auth?: string) => new Headers(auth ? { authorization: auth } : {});

	it("mcpAuthorized: exactly the stored bearer token; nothing without one", () => {
		assert.equal(mcpAuthorized(headers(`Bearer ${TOKEN}`), TOKEN), true);
		assert.equal(mcpAuthorized(headers(`bearer ${TOKEN}`), TOKEN), true);
		assert.equal(mcpAuthorized(headers(`Bearer ${"b".repeat(64)}`), TOKEN), false);
		assert.equal(mcpAuthorized(headers(TOKEN), TOKEN), false);
		assert.equal(mcpAuthorized(headers(), TOKEN), false);
		assert.equal(mcpAuthorized(headers(`Bearer ${TOKEN}`), undefined), false);
		assert.equal(mcpAuthorized(headers("Bearer short"), "short"), false, "a too-short stored token authorizes nothing");
	});

	it("handleMcpRequest refuses non-loopback Host headers (DNS-rebinding belt)", async () => {
		const res = await handleMcpRequest(new Request("http://evil.example/api/mcp", { method: "POST", headers: { host: "evil.example" } }));
		assert.equal(res.status, 403);
	});

	it("the Claude Code command carries the endpoint and the bearer header", () => {
		assert.equal(
			claudeMcpAddCommand("http://localhost:3000/api/mcp", "tok"),
			'claude mcp add --transport http learnharness http://localhost:3000/api/mcp --header "Authorization: Bearer tok"',
		);
	});
});
