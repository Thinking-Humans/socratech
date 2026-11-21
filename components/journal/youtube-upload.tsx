"use client";

/**
 * Upload the notebook video to YouTube — always the learner's confirmed
 * action: title, description, privacy (private by default). Says plainly
 * that the video covers private cells too.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircleIcon, XIcon } from "lucide-react";
import { formatWhen } from "@/lib/utils";

type Status = { configured: boolean; connected: boolean };

export function YouTubeUploadDialog({
	journalId,
	defaultTitle,
	summary,
	last,
	onClose,
}: {
	journalId: string;
	defaultTitle: string;
	summary?: string;
	/** The previous upload of this video, if any. */
	last?: { url: string; privacy: string; at: string };
	onClose: () => void;
}) {
	const [status, setStatus] = useState<Status | null>(null);
	const [title, setTitle] = useState(defaultTitle);
	const [description, setDescription] = useState(summary?.trim() ?? "");
	const [privacy, setPrivacy] = useState<"private" | "unlisted" | "public">("private");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);

	useEffect(() => {
		void fetch("/api/youtube", { cache: "no-store" })
			.then((r) => r.json())
			.then(setStatus)
			.catch(() => setStatus({ configured: false, connected: false }));
	}, []);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [busy, onClose]);

	const upload = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`/api/journals/${encodeURIComponent(journalId)}/video/youtube`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title, description, privacy }),
			});
			const data = (await res.json()) as { error?: string; youtube?: { url: string } };
			if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
			setDone(data.youtube?.url ?? "uploaded");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Upload to YouTube" data-testid="youtube-upload">
			<div className="w-full max-w-lg rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl">
				<div className="mb-3 flex items-center">
					<h2 className="text-sm font-medium">Upload to YouTube</h2>
					<span className="flex-1" />
					<button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded p-1 hover:bg-accent">
						<XIcon className="size-4" />
					</button>
				</div>
				{!status ? (
					<LoaderCircleIcon className="size-4 animate-spin" />
				) : !status.connected ? (
					<p className="text-sm text-muted-foreground">
						Connect your YouTube account first in <b>Settings → Notebook video</b> (needs your own Google OAuth client).
					</p>
				) : done ? (
					<p className="text-sm">
						Uploaded:{" "}
						<a href={done} target="_blank" rel="noreferrer" className="text-primary underline">
							{done}
						</a>
					</p>
				) : (
					<div className="flex flex-col gap-3 text-sm">
						{last && (
							<p className="text-xs text-muted-foreground" data-testid="youtube-last-upload">
								Last uploaded <span className="text-foreground">{formatWhen(last.at)}</span> ({last.privacy}) ·{" "}
								<a href={last.url} target="_blank" rel="noreferrer" className="underline">
									view
								</a>
								. Uploading again makes a new YouTube video.
							</p>
						)}
						<p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
							The video covers the <b>whole</b> notebook, including cells you kept private. Watch it before making it public.
						</p>
						<label className="flex flex-col gap-1">
							<span className="text-xs text-muted-foreground">Title</span>
							<input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} className="lh-input rounded-md border border-border bg-background px-2.5 py-1.5 outline-none" />
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-xs text-muted-foreground">Description</span>
							<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className="lh-input resize-y rounded-md border border-border bg-background px-2.5 py-1.5 outline-none" />
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-xs text-muted-foreground">Visibility</span>
							<select value={privacy} onChange={(e) => setPrivacy(e.target.value as typeof privacy)} className="rounded-md border border-border bg-background px-2 py-1.5" data-testid="youtube-privacy">
								<option value="private">Private</option>
								<option value="unlisted">Unlisted</option>
								<option value="public">Public</option>
							</select>
							<span className="text-[11px] text-muted-foreground">Google keeps uploads from unverified OAuth projects private until the project passes YouTube&apos;s audit.</span>
						</label>
						{error && <p className="text-xs text-destructive">{error}</p>}
						<div className="flex justify-end gap-2">
							<button type="button" onClick={onClose} disabled={busy} className="rounded-md px-3 py-1.5 text-xs hover:bg-accent">
								Cancel
							</button>
							<button type="button" onClick={() => void upload()} disabled={busy || !title.trim()} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50" data-testid="youtube-upload-confirm">
								{busy && <LoaderCircleIcon className="size-3 animate-spin" />}
								Upload {privacy}
							</button>
						</div>
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}
