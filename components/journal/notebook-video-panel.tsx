"use client";

/**
 * The notebook visualizer (owner, 2026-11-21): at the bottom of a notebook,
 * one voiced video of the WHOLE notebook, built by a background Claude Code
 * + HyperFrames job (src/server/notebook-video.ts). Generate / regenerate
 * from scratch, or ask for a change and the agent revises the same project.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ClapperboardIcon, DownloadIcon, LoaderCircleIcon, RefreshCwIcon, SendIcon, SquareIcon, UploadIcon } from "lucide-react";
import { journalMediaUrl, type NotebookVideoState } from "@/src/core";
import { cn, formatWhen } from "@/lib/utils";
import { YouTubeUploadDialog } from "@/components/journal/youtube-upload";
import { useSettingsDialog } from "@/components/settings/settings-dialog";

type View = NotebookVideoState & { stale: boolean; setup: { claude: boolean; skills: boolean; kokoro: boolean; ffmpeg: boolean } };

async function call(url: string, method = "GET", body?: unknown): Promise<View> {
	const res = await fetch(url, { method, cache: "no-store", ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
	const data = (await res.json().catch(() => ({}))) as View & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
	return data;
}

function elapsed(from?: string, to?: string): string {
	if (!from) return "";
	const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function NotebookVideoPanel({ journalId, title }: { journalId: string; title: string }) {
	const url = `/api/journals/${encodeURIComponent(journalId)}/video`;
	const [view, setView] = useState<View | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [request, setRequest] = useState("");
	const [busy, setBusy] = useState(false);
	const [uploadOpen, setUploadOpen] = useState(false);
	const [, tick] = useState(0);
	const settings = useSettingsDialog();
	const running = view?.status === "running";

	const refresh = useCallback(async () => {
		try {
			setView(await call(url));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [url]);
	useEffect(() => void refresh(), [refresh]);
	// Poll while the job runs (and tick the elapsed clock).
	const timer = useRef<ReturnType<typeof setInterval> | null>(null);
	useEffect(() => {
		if (!running) return;
		timer.current = setInterval(() => {
			tick((n) => n + 1);
			void refresh();
		}, 2000);
		return () => {
			if (timer.current) clearInterval(timer.current);
		};
	}, [running, refresh]);

	const act = async (method: "POST" | "DELETE", body?: unknown) => {
		setBusy(true);
		setError(null);
		try {
			setView(await call(url, method, body));
			if (method === "POST") setRequest("");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	if (!view) return null;
	const missing = !view.setup.claude ? "Claude Code" : !view.setup.skills || !view.setup.kokoro || !view.setup.ffmpeg ? "the video tools" : null;
	const hasVideo = Boolean(view.video);

	return (
		<section className="mt-8 rounded-xl border border-border bg-card/40 p-4" data-testid="notebook-video" aria-label="Notebook visualizer">
			<div className="flex flex-wrap items-center gap-2">
				<ClapperboardIcon className="size-4 text-primary" />
				<h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Notebook visualizer</h2>
				{hasVideo && view.stale && !running && <span className="text-[11px] text-warning">the notebook changed since this video</span>}
				<span className="flex-1" />
				{running ? (
					<button type="button" disabled={busy} onClick={() => void act("DELETE")} className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent" data-testid="notebook-video-cancel">
						<SquareIcon className="size-3" /> Cancel
					</button>
				) : (
					<button
						type="button"
						disabled={busy || Boolean(missing)}
						onClick={() => void act("POST", {})}
						title={hasVideo ? "Make the video again from scratch" : "Make a voiced video of the whole notebook (about 10–30 minutes)"}
						className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-40"
						data-testid="notebook-video-generate"
					>
						<RefreshCwIcon className="size-3" /> {hasVideo ? "Regenerate" : "Generate video"}
					</button>
				)}
				{hasVideo && !running && (
					<>
						<a href={journalMediaUrl(journalId, view.video!)} download={`${title || "notebook"}.mp4`} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Download MP4" aria-label="Download MP4">
							<DownloadIcon className="size-3.5" />
						</a>
						<button type="button" onClick={() => setUploadOpen(true)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title={view.youtube ? `Upload to YouTube again (last uploaded ${formatWhen(view.youtube.at)})` : "Upload to YouTube"} aria-label="Upload to YouTube" data-testid="notebook-video-youtube">
							<UploadIcon className="size-3.5" />
						</button>
					</>
				)}
			</div>

			{missing && (
				<p className="mt-2 text-xs text-muted-foreground">
					Needs {missing}.{" "}
					<button type="button" className="underline" onClick={() => settings?.open("notebook-video")}>
						Set it up in Settings → Notebook video
					</button>
				</p>
			)}

			{running && (
				<div className="mt-3 rounded-md border border-dashed border-primary/40 px-3 py-2 text-xs text-muted-foreground" data-testid="notebook-video-progress">
					<div className="mb-1 flex items-center gap-2 text-foreground">
						<LoaderCircleIcon className="size-3.5 animate-spin text-primary" />
						{view.kind === "update" ? "Updating the video" : "Making the video"} · {elapsed(view.startedAt)}
						<span className="text-muted-foreground">— you can keep working; it runs in the background</span>
					</div>
					{view.log.slice(-6).map((l, i) => (
						<div key={i} className="truncate font-mono text-[11px]">{l}</div>
					))}
				</div>
			)}

			{hasVideo && (
				<video
					key={view.video}
					controls
					preload="metadata"
					src={journalMediaUrl(journalId, view.video!)}
					className={cn("mt-3 w-full rounded-lg border border-border bg-black", running && "opacity-60")}
					data-testid="notebook-video-player"
				/>
			)}
			{hasVideo && view.summary && !running && <p className="mt-2 text-xs text-muted-foreground">{view.summary.split("\n")[0]}</p>}
			{hasVideo && view.youtube && !running && (
				<p className="mt-1 text-xs text-muted-foreground">
					Uploaded to YouTube {formatWhen(view.youtube.at)} ({view.youtube.privacy}):{" "}
					<a href={view.youtube.url} target="_blank" rel="noreferrer" className="text-primary underline">
						{view.youtube.url}
					</a>
				</p>
			)}

			{(view.status === "failed" || view.status === "interrupted" || view.status === "cancelled") && !running && (
				<p className={cn("mt-2 text-xs", view.status === "failed" ? "text-destructive" : "text-muted-foreground")} data-testid="notebook-video-error">
					{view.status === "failed" ? `The last run failed: ${view.error ?? "unknown error"}` : view.status === "cancelled" ? "The last run was cancelled." : "The last run was cut off (the app restarted)."}
					{view.finishedAt && view.startedAt ? ` (${elapsed(view.startedAt, view.finishedAt)})` : ""}
				</p>
			)}

			{hasVideo && !running && (
				<form
					className="mt-3 flex items-end gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (request.trim()) void act("POST", { request: request.trim() });
					}}
				>
					<textarea
						value={request}
						onChange={(e) => setRequest(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && request.trim()) {
								e.preventDefault();
								void act("POST", { request: request.trim() });
							}
						}}
						placeholder="Change something — e.g. slower voice, add an intro card, redo the scene about recursion… (Ctrl/⌘+Enter)"
						aria-label="What should change in the video"
						className="field-sizing-content lh-input min-h-9 flex-1 resize-none rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none"
						data-testid="notebook-video-request"
					/>
					<button type="submit" disabled={busy || !request.trim() || Boolean(missing)} className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-2 text-xs hover:bg-accent disabled:opacity-40" data-testid="notebook-video-update">
						<SendIcon className="size-3" /> Update video
					</button>
				</form>
			)}
			{error && <p className="mt-2 text-xs text-destructive">{error}</p>}
			{uploadOpen && view.video && (
				<YouTubeUploadDialog
					journalId={journalId}
					defaultTitle={title}
					summary={view.summary}
					last={view.youtube}
					onClose={() => {
						setUploadOpen(false);
						void refresh();
					}}
				/>
			)}
		</section>
	);
}
