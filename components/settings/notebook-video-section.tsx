"use client";

/**
 * Settings → Notebook video (owner, 2026-11-21): the notebook visualizer's
 * tools, its taste + workflow skill (an editable SKILL.md the video agent
 * follows — add steps or rules here), and the YouTube connection.
 */

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { SettingsGroup, SettingsRow } from "./controls";

type Setup = { claude: boolean; skills: boolean; kokoro: boolean; ffmpeg: boolean };
type View = { taste: string; custom: boolean; defaultTaste: string; setup: Setup; error?: string };
type YouTube = { configured: boolean; connected: boolean; clientId?: string };

const SETUP_LABEL: Record<keyof Setup, string> = {
	claude: "Claude Code (Settings → Claude / Models)",
	skills: "HyperFrames skills",
	kokoro: "Local Kokoro voice",
	ffmpeg: "FFmpeg",
};

async function json<T>(url: string, method = "GET", body?: unknown): Promise<T> {
	const res = await fetch(url, { method, cache: "no-store", ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
	const data = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
	return data;
}

export function NotebookVideoSection() {
	const [view, setView] = useState<View | null>(null);
	const [draft, setDraft] = useState("");
	const [installing, setInstalling] = useState(false);
	const [saved, setSaved] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [yt, setYt] = useState<YouTube | null>(null);
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");

	const load = useCallback(async () => {
		try {
			const v = await json<View>("/api/settings/notebook-video");
			setView(v);
			setDraft(v.taste);
			const y = await json<YouTube>("/api/youtube");
			setYt(y);
			setClientId(y.clientId ?? "");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);
	useEffect(() => void load(), [load]);

	const run = async (fn: () => Promise<void>) => {
		setError(null);
		setSaved(null);
		try {
			await fn();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	if (!view) return <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />;
	const ready = Object.values(view.setup).every(Boolean);

	return (
		<div data-testid="notebook-video-settings">
			<SettingsGroup label="Tools">
				{(Object.keys(SETUP_LABEL) as (keyof Setup)[]).map((k) => (
					<SettingsRow key={k} label={SETUP_LABEL[k]}>
						{view.setup[k] ? <CheckIcon className="size-4 text-success" /> : <XIcon className="size-4 text-error" />}
					</SettingsRow>
				))}
				{!ready && (
					<div className="flex items-center gap-2">
						<button
							type="button"
							disabled={installing}
							onClick={() =>
								void run(async () => {
									setInstalling(true);
									try {
										const v = await json<View>("/api/settings/notebook-video", "POST", { action: "install" });
										setView(v);
									} finally {
										setInstalling(false);
									}
								})
							}
							className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
							data-testid="notebook-video-install"
						>
							{installing && <LoaderCircleIcon className="size-3 animate-spin" />}
							Install video tools
						</button>
						<span className="text-[11px] text-muted-foreground">HyperFrames skills, the render browser and Kokoro (~300 MB, one time).</span>
					</div>
				)}
			</SettingsGroup>

			<SettingsGroup label="Taste & workflow skill">
				<p className="text-xs text-muted-foreground">
					The video agent follows this skill for every notebook video: look, voice, length and the steps it takes. Add your own rules or steps at the end.
					{view.custom ? " (customised)" : " (default)"}
				</p>
				<textarea
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					spellCheck={false}
					rows={18}
					className="lh-input w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs outline-none"
					data-testid="notebook-video-taste"
				/>
				<div className="flex items-center gap-2">
					<button
						type="button"
						disabled={draft === view.taste}
						onClick={() => void run(async () => {
							setView(await json<View>("/api/settings/notebook-video", "PUT", { taste: draft }));
							setSaved("Saved — the next video uses it.");
						})}
						className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-40"
						data-testid="notebook-video-taste-save"
					>
						Save
					</button>
					{view.custom && (
						<button
							type="button"
							onClick={() => void run(async () => {
								const v = await json<View>("/api/settings/notebook-video", "DELETE");
								setView(v);
								setDraft(v.taste);
								setSaved("Back to the default.");
							})}
							className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							Reset to default
						</button>
					)}
					{saved && <span className="text-[11px] text-success">{saved}</span>}
				</div>
			</SettingsGroup>

			<SettingsGroup label="YouTube">
				<p className="text-xs text-muted-foreground">
					Uploads use your own Google OAuth client: in Google Cloud, enable <i>YouTube Data API v3</i>, create an OAuth client of type <b>Desktop app</b>, and paste its ID and secret here.
					Uploads from unverified projects stay private until Google audits the project.
				</p>
				<input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" aria-label="Google OAuth client ID" className="lh-input rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none" />
				<input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={yt?.configured ? "Client secret (saved — paste to replace)" : "Client secret"} type="password" aria-label="Google OAuth client secret" className="lh-input rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none" />
				<div className="flex items-center gap-2">
					<button
						type="button"
						disabled={!clientId.trim() || !clientSecret.trim()}
						onClick={() => void run(async () => {
							setYt(await json<YouTube>("/api/youtube", "PUT", { clientId, clientSecret }));
							setClientSecret("");
						})}
						className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-40"
					>
						Save client
					</button>
					<button
						type="button"
						disabled={!yt?.configured}
						onClick={() => void run(async () => {
							const { url } = await json<{ url: string }>("/api/youtube", "POST", { action: "connect" });
							window.open(url, "_blank", "noopener");
						})}
						className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-40"
						data-testid="youtube-connect"
					>
						{yt?.connected ? "Reconnect" : "Connect YouTube"}
					</button>
					{yt?.connected && (
						<>
							<span className="text-[11px] text-success">connected</span>
							<button type="button" onClick={() => void run(async () => setYt(await json<YouTube>("/api/youtube", "DELETE")))} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent">
								Disconnect
							</button>
						</>
					)}
					<button type="button" onClick={() => void load()} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent" title="Refresh after signing in">
						Refresh
					</button>
				</div>
			</SettingsGroup>
			{(error || view.error) && <p className="mt-3 text-xs text-destructive">{error ?? view.error}</p>}
		</div>
	);
}
