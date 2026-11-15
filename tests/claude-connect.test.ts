/**
 * Connect Claude (owner, 2026-11-16): Claude Code via its CLI, Claude
 * Desktop via its config + the stdio bridge — on fakes and a temp home;
 * the bridge itself against a real local HTTP server.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-claude-connect-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");
const { BRIDGE_SOURCE, MCP_SERVER_NAME, claudeDesktopConfigPath, connectClaude } = await import("../src/server/claude-connect.ts");
type Deps = Parameters<typeof connectClaude>[1] & object;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const TOKEN = "t".repeat(64);

function deps(home: string, over: Partial<Deps> = {}): { deps: Deps; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		deps: {
			findClaude: () => "/bin/claude",
			run: async (_bin, args) => void calls.push(args),
			homeDir: home,
			platform: "linux",
			env: {},
			dataDir: path.join(home, "data"),
			nodeBinary: "/usr/bin/node",
			token: () => TOKEN,
			...over,
		},
	};
}

function home(name: string, desktopConfig?: string): string {
	const dir = path.join(TMP, name);
	if (desktopConfig !== undefined) {
		const file = claudeDesktopConfigPath("linux", dir, {});
		fs.mkdirSync(path.dirname(file), { recursive: true });
		if (desktopConfig) fs.writeFileSync(file, desktopConfig);
	} else fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("connectClaude", () => {
	it("re-adds the http server in Claude Code at user scope", async () => {
		const { deps: d, calls } = deps(home("code"));
		const [code, desktop] = await connectClaude("http://127.0.0.1:47823/", d);
		assert.equal(code!.status, "connected");
		assert.equal(desktop!.status, "not-found");
		assert.deepEqual(calls, [
			["mcp", "remove", "--scope", "user", MCP_SERVER_NAME],
			["mcp", "add", "--transport", "http", "--scope", "user", MCP_SERVER_NAME, "http://127.0.0.1:47823/api/mcp", "--header", `Authorization: Bearer ${TOKEN}`],
		]);
	});

	it("reports a missing CLI and a failing add", async () => {
		assert.equal((await connectClaude("http://localhost:3000", deps(home("none"), { findClaude: () => null }).deps))[0]!.status, "not-found");
		const failing = deps(home("fail"), { run: async (_b, args) => { if (args[1] === "add") throw new Error("boom"); } }).deps;
		assert.deepEqual((await connectClaude("http://localhost:3000", failing))[0], { client: "claude-code", status: "failed", detail: "boom" });
	});

	it("merges into Claude Desktop's config, keeping other servers and keys", async () => {
		const dir = home("desk", JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
		const [, desktop] = await connectClaude("http://localhost:3000", deps(dir).deps);
		assert.equal(desktop!.status, "connected");
		const config = JSON.parse(fs.readFileSync(claudeDesktopConfigPath("linux", dir, {}), "utf-8"));
		assert.equal(config.theme, "dark");
		assert.deepEqual(config.mcpServers.other, { command: "x" });
		const entry = config.mcpServers[MCP_SERVER_NAME];
		assert.equal(entry.command, "/usr/bin/node");
		assert.equal(entry.env.SOCRATECH_MCP_URL, "http://localhost:3000/api/mcp");
		assert.equal(entry.env.SOCRATECH_MCP_TOKEN, TOKEN);
		assert.equal(fs.readFileSync(entry.args[0], "utf-8"), BRIDGE_SOURCE);
	});

	it("creates Desktop's config when only its folder exists; leaves bad JSON alone", async () => {
		const fresh = home("desk-empty", "");
		assert.equal((await connectClaude("http://localhost:3000", deps(fresh).deps))[1]!.status, "connected");
		const bad = home("desk-bad", "{ not json");
		const [, desktop] = await connectClaude("http://localhost:3000", deps(bad).deps);
		assert.equal(desktop!.status, "failed");
		assert.match(desktop!.detail!, /not valid JSON/);
		assert.equal(fs.readFileSync(claudeDesktopConfigPath("linux", bad, {}), "utf-8"), "{ not json");
	});

	it("config paths per platform", () => {
		assert.equal(claudeDesktopConfigPath("darwin", "/h", {}), "/h/Library/Application Support/Claude/claude_desktop_config.json");
		assert.equal(claudeDesktopConfigPath("linux", "/h", {}), "/h/.config/Claude/claude_desktop_config.json");
	});
});

describe("stdio bridge", () => {
	it("forwards each line with the token and answers errors for requests", async () => {
		const seen: Array<{ auth?: string; body: string }> = [];
		const server = http.createServer((req, res) => {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				seen.push({ auth: req.headers.authorization, body });
				const msg = JSON.parse(body);
				if (msg.id === undefined) return void res.writeHead(202).end();
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echo: msg.method } }));
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as { port: number }).port;
		const bridge = path.join(TMP, "bridge.cjs");
		fs.writeFileSync(bridge, BRIDGE_SOURCE);
		const child = spawn(process.execPath, [bridge], { env: { ...process.env, SOCRATECH_MCP_URL: `http://127.0.0.1:${port}/api/mcp`, SOCRATECH_MCP_TOKEN: TOKEN } });
		let out = "";
		child.stdout.on("data", (c) => (out += c));
		child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
		child.stdin.end();
		await new Promise((r) => child.on("close", r));
		server.close();
		assert.deepEqual(out.trim().split("\n").map((l) => JSON.parse(l)), [
			{ jsonrpc: "2.0", id: 1, result: { echo: "initialize" } },
			{ jsonrpc: "2.0", id: 2, result: { echo: "tools/list" } },
		]);
		assert.equal(seen.length, 3);
		assert.ok(seen.every((s) => s.auth === `Bearer ${TOKEN}`));
	});
});
