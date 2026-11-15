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

export function ClaudeSection() {
	const [token, setToken] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [copied, setCopied] = useState(false);
	const [setupCopied, setSetupCopied] = useState(false);
	const [endpoint, setEndpoint] = useState("http://localhost:3000/api/mcp");

	useEffect(() => {
		setEndpoint(`${window.location.origin}/api/mcp`);
		fetch("/api/settings/mcp")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
			.then((body: { token: string }) => setToken(body.token))
			.catch(() => setFailed(true));
	}, []);

	const rotate = () => {
		setCopied(false);
		setSetupCopied(false);
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
					The token lets Claude read your ideas and record judgments. A new token disconnects every client using the old one.
				</span>
			</div>
			<div className="flex flex-col gap-1.5" data-testid="clip-extension-setup">
				<span className="font-prose text-(length:--lh-prose-size)">Chrome extension (web clip)</span>
				<span className="text-xs text-muted-foreground/70">
					Load <code className="font-mono">extensions/chrome</code> unpacked, open its options, and paste this setup. It uses the same token.
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
