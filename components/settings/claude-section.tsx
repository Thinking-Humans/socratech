"use client";
/**
 * The Claude section (Claude integration, 2026-10-30): connect the user's
 * own Claude clients (Claude Code, Desktop, claude.ai — on their Claude
 * subscription) to the gym's MCP endpoint. Shows the endpoint, the
 * ready-to-paste `claude mcp add` command carrying the bearer token, and
 * a rotate control (every configured client must then be re-added).
 */

import { useEffect, useState } from "react";
import { SettingsRow } from "./controls.tsx";

/** The Claude Code command that registers the endpoint (pure — tests pin it). */
export function claudeMcpAddCommand(endpoint: string, token: string): string {
	return `claude mcp add --transport http learnharness ${endpoint} --header "Authorization: Bearer ${token}"`;
}

/** What the Chrome extension's options page accepts as one paste (docs/web-clip.md). */
export function clipExtensionSetup(origin: string, token: string): string {
	return JSON.stringify({ server: origin, token });
}

type ClientStatus = "connected" | "not-found" | "failed" | "not-installed";
interface ConnectRow {
	client: string;
	status: ClientStatus;
	detail?: string;
}

const CLIENT_LABELS: Record<string, string> = {
	"claude-code": "Claude Code",
	"claude-desktop": "Claude Desktop",
	"chrome-extension": "Chrome extension",
};

/** Hand the token to the Socratech Clip extension's content script, if installed
 *  (extensions/chrome/connect.js). It checks the token against this origin first. */
function connectExtension(token: string): Promise<ConnectRow> {
	return new Promise((resolve) => {
		const nonce = crypto.randomUUID();
		const finish = (row: Omit<ConnectRow, "client">) => {
			clearTimeout(timer);
			window.removeEventListener("message", onMessage);
			resolve({ client: "chrome-extension", ...row });
		};
		const onMessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; nonce?: string; ok?: boolean; error?: string } | null;
			if (event.source !== window || data?.nonce !== nonce) return;
			if (data.type === "socratech-clip-connecting") {
				// Installed: now wait for its token check (a first request can be slow).
				clearTimeout(timer);
				timer = setTimeout(() => finish({ status: "failed", detail: "the extension did not answer" }), 30_000);
			} else if (data.type === "socratech-clip-connected") {
				finish(data.ok ? { status: "connected" } : { status: "failed", detail: data.error });
			}
		};
		let timer = setTimeout(() => finish({ status: "not-installed" }), 1500);
		window.addEventListener("message", onMessage);
		window.postMessage({ type: "socratech-clip-setup", token, nonce }, window.location.origin);
	});
}

function statusText(row: ConnectRow): string {
	if (row.status === "connected") return "connected";
	if (row.status === "not-found") return "not installed";
	if (row.status === "not-installed") return "not installed (load extensions/chrome)";
	return "failed";
}

export function ClaudeSection() {
	const [token, setToken] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [copied, setCopied] = useState(false);
	const [setupCopied, setSetupCopied] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const [rows, setRows] = useState<ConnectRow[] | null>(null);
	const [endpoint, setEndpoint] = useState("http://localhost:3000/api/mcp");

	useEffect(() => {
		setEndpoint(`${window.location.origin}/api/mcp`);
		fetch("/api/settings/mcp")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
			.then((body: { token: string }) => setToken(body.token))
			.catch(() => setFailed(true));
	}, []);

	const connect = async () => {
		if (!token) return;
		setConnecting(true);
		setRows(null);
		try {
			const [server, extension] = await Promise.all([
				fetch("/api/settings/mcp/connect", { method: "POST" })
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
					.then((body: { clients: ConnectRow[] }) => body.clients)
					.catch((err: unknown) => [{ client: "claude-code", status: "failed" as const, detail: String(err) }]),
				connectExtension(token),
			]);
			setRows([...server, extension]);
		} finally {
			setConnecting(false);
		}
	};

	const rotate = () => {
		setCopied(false);
		setSetupCopied(false);
		setRows(null);
		fetch("/api/settings/mcp", { method: "POST" })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
			.then((body: { token: string }) => setToken(body.token))
			.catch(() => setFailed(true));
	};

	if (failed) return <p className="text-xs text-destructive">Could not load the MCP token.</p>;
	if (token === null) return <p className="text-xs text-muted-foreground">Loading…</p>;
	const command = claudeMcpAddCommand(endpoint, token);
	const setup = clipExtensionSetup(endpoint.replace(/\/api\/mcp$/, ""), token);

	return (
		<>
			<div className="flex flex-col gap-1.5" data-testid="claude-connect">
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => void connect()}
						disabled={connecting}
						className="rounded-md border bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
					>
						{connecting ? "Connecting…" : "Connect Claude"}
					</button>
					<span className="text-xs text-muted-foreground/70">Sets up Claude Code, Claude Desktop and the Chrome extension on this computer.</span>
				</div>
				{rows && (
					<ul className="flex flex-col gap-0.5 text-xs" data-testid="claude-connect-results">
						{rows.map((row) => (
							<li key={row.client} className={row.status === "failed" ? "text-destructive" : row.status === "connected" ? "" : "text-muted-foreground"}>
								{CLIENT_LABELS[row.client] ?? row.client}: {statusText(row)}
								{row.detail ? ` — ${row.detail}` : ""}
							</li>
						))}
					</ul>
				)}
			</div>
			<SettingsRow label="Endpoint" hint="Streamable HTTP. Works while this app is running.">
				<code className="font-mono text-xs">{endpoint}</code>
			</SettingsRow>
			<div className="flex flex-col gap-1.5" data-testid="claude-mcp-command">
				<span className="font-prose text-(length:--lh-prose-size)">Add to Claude Code</span>
				<pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all">{command}</pre>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true))}
						className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
					>
						{copied ? "Copied" : "Copy command"}
					</button>
					<button type="button" onClick={rotate} className="rounded-md border px-2 py-1 text-xs hover:bg-accent">
						New token
					</button>
				</div>
				<span className="text-xs text-muted-foreground/70">
					The token lets Claude read your ideas and record judgments. A new token disconnects every client using the old one — press Connect Claude again after.
				</span>
			</div>
			<div className="flex flex-col gap-1.5" data-testid="clip-extension-setup">
				<span className="font-prose text-(length:--lh-prose-size)">Chrome extension (web clip)</span>
				<span className="text-xs text-muted-foreground/70">
					Load <code className="font-mono">extensions/chrome</code> unpacked, then press Connect Claude above. Or paste this setup into its options by hand.
				</span>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => void navigator.clipboard.writeText(setup).then(() => setSetupCopied(true))}
						className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
					>
						{setupCopied ? "Copied" : "Copy extension setup"}
					</button>
				</div>
			</div>
		</>
	);
}
