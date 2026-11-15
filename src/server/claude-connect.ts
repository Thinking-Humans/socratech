/**
 * One-click "Connect Claude" (owner, 2026-11-16): register this app's MCP
 * endpoint with every local Claude client found, on the user's click.
 *
 *   Claude Code     `claude mcp remove` + `claude mcp add --scope user` (http)
 *   Claude Desktop  its config takes stdio servers, so the entry runs a tiny
 *                   stdio→HTTP bridge written into the data dir, on this
 *                   server's own Node/Electron binary (no npx, no download)
 *
 * The Chrome extension is connected from the page (postMessage → the
 * extension's content script), not here. claude.ai / Claude in Chrome run
 * off this machine and cannot reach loopback — not covered.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { externalCliEnv } from "../core/auth-env.ts";
import { getClaudeBinary } from "../agent/claude-code/binary.ts";
import { subscriptionRequestOrigin } from "./desktop-access.ts";
import { mcpToken } from "./mcp-access.ts";

/** The name every client registers the endpoint under (matches the Settings command). */
export const MCP_SERVER_NAME = "learnharness";

export type ConnectStatus = "connected" | "not-found" | "failed";
export interface ClientResult {
	client: "claude-code" | "claude-desktop";
	status: ConnectStatus;
	detail?: string;
}

export interface ConnectDeps {
	findClaude: () => string | null;
	run: (binary: string, args: string[]) => Promise<void>;
	homeDir: string;
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	dataDir: string;
	nodeBinary: string;
	token: () => string;
}

const run: ConnectDeps["run"] = (binary, args) =>
	new Promise((resolve, reject) => {
		execFile(binary, args, { cwd: os.tmpdir(), env: externalCliEnv(), windowsHide: true, timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 64_000 }, (error, _stdout, stderr) =>
			error ? reject(new Error(String(stderr || error.message).trim().slice(0, 300))) : resolve(),
		);
	});

export function defaultConnectDeps(): ConnectDeps {
	return {
		findClaude: getClaudeBinary,
		run,
		homeDir: os.homedir(),
		platform: process.platform,
		env: process.env,
		dataDir: PATHS.data,
		nodeBinary: process.execPath,
		token: mcpToken,
	};
}

/** Claude Desktop's config file for this platform. */
export function claudeDesktopConfigPath(platform: NodeJS.Platform, homeDir: string, env: Record<string, string | undefined>): string {
	if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
	if (platform === "win32") return path.join(env.APPDATA ?? path.join(homeDir, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
	return path.join(env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config"), "Claude", "claude_desktop_config.json");
}

/** stdio ⇄ HTTP: each JSON-RPC line from Claude Desktop is POSTed to the endpoint, in order. */
export const BRIDGE_SOURCE = `// Socratech MCP bridge (written by Settings → Claude → Connect Claude).
"use strict";
const url = process.env.SOCRATECH_MCP_URL;
const token = process.env.SOCRATECH_MCP_TOKEN;
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let chain = Promise.resolve();
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
	if (line.trim()) chain = chain.then(() => forward(line));
});
async function forward(line) {
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: line,
		});
		if (res.status === 202 || res.status === 204) return;
		const text = await res.text();
		if (!res.ok) throw new Error("HTTP " + res.status + " " + text.slice(0, 200));
		const body = JSON.parse(text);
		for (const m of Array.isArray(body) ? body : [body]) out(m);
	} catch (err) {
		if (msg && msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Socratech is not reachable (is the app running?): " + err.message } });
	}
}
`;

async function connectClaudeCode(endpoint: string, deps: ConnectDeps): Promise<ClientResult> {
	const binary = deps.findClaude();
	if (!binary) return { client: "claude-code", status: "not-found" };
	try {
		await deps.run(binary, ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME]).catch(() => {});
		await deps.run(binary, ["mcp", "add", "--transport", "http", "--scope", "user", MCP_SERVER_NAME, endpoint, "--header", `Authorization: Bearer ${deps.token()}`]);
		return { client: "claude-code", status: "connected" };
	} catch (err) {
		return { client: "claude-code", status: "failed", detail: err instanceof Error ? err.message : String(err) };
	}
}

function connectClaudeDesktop(endpoint: string, deps: ConnectDeps): ClientResult {
	const configPath = claudeDesktopConfigPath(deps.platform, deps.homeDir, deps.env);
	if (!fs.existsSync(path.dirname(configPath))) return { client: "claude-desktop", status: "not-found" };
	try {
		let config: Record<string, unknown> = {};
		if (fs.existsSync(configPath)) {
			const raw = fs.readFileSync(configPath, "utf-8");
			if (raw.trim()) {
				const parsed: unknown = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("its config is not a JSON object — left untouched");
				config = parsed as Record<string, unknown>;
			}
		}
		const bridge = path.join(deps.dataDir, "mcp-bridge.cjs");
		fs.mkdirSync(deps.dataDir, { recursive: true });
		fs.writeFileSync(bridge, BRIDGE_SOURCE, { mode: 0o600 });
		const servers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) ? (config.mcpServers as Record<string, unknown>) : {};
		const next = {
			...config,
			mcpServers: {
				...servers,
				[MCP_SERVER_NAME]: {
					command: deps.nodeBinary,
					args: [bridge],
					env: { ELECTRON_RUN_AS_NODE: "1", SOCRATECH_MCP_URL: endpoint, SOCRATECH_MCP_TOKEN: deps.token() },
				},
			},
		};
		const tmp = `${configPath}.socratech-tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(tmp, configPath);
		return { client: "claude-desktop", status: "connected", detail: "Restart Claude Desktop to load it." };
	} catch (err) {
		const message = err instanceof SyntaxError ? "its config is not valid JSON — left untouched" : err instanceof Error ? err.message : String(err);
		return { client: "claude-desktop", status: "failed", detail: message };
	}
}

/** Register `origin`/api/mcp with every local Claude client found. */
export async function connectClaude(origin: string, deps: ConnectDeps = defaultConnectDeps()): Promise<ClientResult[]> {
	const endpoint = `${origin.replace(/\/+$/, "")}/api/mcp`;
	return [await connectClaudeCode(endpoint, deps), connectClaudeDesktop(endpoint, deps)];
}

/** The route: this app's own origin (never a forwarded one) → every client's result. */
export async function connectClaudeResponse(request: Request): Promise<Response> {
	const origin = subscriptionRequestOrigin(request);
	if (!origin) return Response.json({ error: "Could not tell this app's address." }, { status: 400 });
	return Response.json({ clients: await connectClaude(origin) }, { headers: { "Cache-Control": "no-store" } });
}
