"use client";

/**
 * The publish confirmation (learn-in-public phase 4, D10): the server's dry
 * run, shown verbatim — where the bundle lands, each file's status, the
 * commit message, the push target — and blockers. Preview mode shows the
 * exact index.md; publish mode adds the Confirm button. Nothing leaves the
 * machine until Confirm (the push is public).
 */

import { useEffect, useState } from "react";
import { journalApi, type PublishPlan, type PublishResult } from "@/components/journal/journal-api";
import { cn, formatWhen } from "@/lib/utils";
import type { JournalPublication } from "@/src/core";

const STATUS_TONE: Record<PublishPlan["files"][number]["status"], string> = {
	new: "text-primary",
	changed: "text-foreground",
	unchanged: "text-muted-foreground",
	removed: "text-destructive",
};

/** What happened to the published reflections (D7). */
const GRAPH_NOTE: Record<PublishResult["graphImport"], string> = {
	started: "reflections are being added to your graph",
	"models-missing": "set up models to add reflections to your graph",
	"graph-off": "graph is off — reflections not added",
	nothing: "",
	unchanged: "",
	test: "",
};

export function PublishPanel({
	journalId,
	mode,
	revision,
	lastPublished,
	onClose,
	onPublished,
}: {
	journalId: string;
	mode: "preview" | "publish";
	/** Bumps when the journal changed — the plan is re-fetched. */
	revision: string;
	/** The latest publication, if any — shown so a republish knows what it replaces. */
	lastPublished?: JournalPublication;
	onClose: () => void;
	onPublished: (r: PublishResult) => void;
}) {
	const [plan, setPlan] = useState<PublishPlan | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<PublishResult | null>(null);

	useEffect(() => {
		let live = true;
		journalApi
			.plan(journalId)
			.then((p) => live && (setPlan(p), setError(null)))
			.catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
		return () => {
			live = false;
		};
	}, [journalId, revision]);

	if (error && !plan) return <p className="text-xs text-destructive">{error}</p>;
	if (!plan) return <p className="text-xs text-muted-foreground">Preparing…</p>;

	const index = plan.files.find((f) => f.name === "index.md");
	const nothingToDo = plan.files.length > 0 && plan.files.every((f) => f.status === "unchanged") && !plan.siteConfig;

	return (
		<div className="flex flex-col gap-3" data-testid={mode === "publish" ? "journal-publish-panel" : "journal-preview"}>
			{lastPublished && !result && (
				<p className="text-xs text-muted-foreground" data-testid="journal-last-published">
					Last published <span className="text-foreground">{formatWhen(lastPublished.at)}</span>
					{lastPublished.commit && <span className="font-mono"> · {lastPublished.commit.slice(0, 7)}</span>}
					{lastPublished.url && (
						<>
							{" · "}
							<a href={lastPublished.url} target="_blank" rel="noreferrer" className="underline">
								view
							</a>
						</>
					)}
				</p>
			)}
			{plan.target && plan.dir && (
				<div className="flex flex-col gap-1 rounded-md border border-border p-3 text-xs">
					<div>
						<span className="text-muted-foreground">Site repo </span>
						<span className="font-mono">{plan.target.siteRepo}</span>
					</div>
					<div>
						<span className="text-muted-foreground">{plan.republish ? "Updates " : "Creates "}</span>
						<span className="font-mono">{plan.dir}/</span>
						{plan.files.map((f) => (
							<span key={f.name} className={cn("ml-2 font-mono", STATUS_TONE[f.status])}>
								{f.name} ({f.status})
							</span>
						))}
					</div>
					{plan.siteConfig && (
						<div data-testid="journal-publish-site-config">
							<span className="text-muted-foreground">Site config </span>
							<span className={cn("font-mono", STATUS_TONE[plan.siteConfig.status])}>
								{plan.siteConfig.name} ({plan.siteConfig.status})
							</span>
							<span className="text-muted-foreground"> — serves media/*.html as static files</span>
						</div>
					)}
					<div>
						<span className="text-muted-foreground">Commit </span>
						<span className="font-mono">{plan.commitMessage.split("\n")[0]}</span>
					</div>
					<div>
						<span className="text-muted-foreground">Push </span>
						{plan.target.push ? (
							<span className="font-mono">
								{plan.remote ?? "?"}/{plan.branch ?? "?"}
							</span>
						) : (
							<span>off — commit only</span>
						)}
						{plan.url && (
							<>
								<span className="text-muted-foreground"> → </span>
								<span className="font-mono">{plan.url}</span>
							</>
						)}
					</div>
				</div>
			)}

			{plan.blockers.length > 0 && (
				<ul className="flex flex-col gap-1 text-xs text-destructive" role="alert" data-testid="journal-publish-blockers">
					{plan.blockers.map((b) => (
						<li key={b} className="whitespace-pre-wrap">{b}</li>
					))}
				</ul>
			)}

			{mode === "publish" && !result && (
				<div className="flex items-center gap-2">
					<button
						type="button"
						data-testid="journal-publish-confirm"
						disabled={busy || plan.blockers.length > 0 || !plan.dir || nothingToDo}
						onClick={async () => {
							setBusy(true);
							setError(null);
							try {
								const r = await journalApi.publish(journalId, plan.dir!);
								setResult(r);
								onPublished(r);
							} catch (err) {
								setError(err instanceof Error ? err.message : String(err));
							} finally {
								setBusy(false);
							}
						}}
						className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-primary-foreground transition-opacity disabled:opacity-40"
					>
						{busy ? "Publishing…" : plan.target?.push ? "Confirm: commit & push" : "Confirm: commit"}
					</button>
					<button type="button" onClick={onClose} className="px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground">
						Cancel
					</button>
					{nothingToDo && <span className="text-xs text-muted-foreground">Already up to date.</span>}
				</div>
			)}

			{result && (
				<p className="text-xs" role="status" data-testid="journal-publish-result">
					{result.changed ? (
						<>
							Committed <span className="font-mono">{result.commit?.slice(0, 7)}</span>
							{result.pushed ? ` and pushed to ${plan.remote}/${plan.branch}` : ""}.
						</>
					) : (
						"Nothing changed — no commit."
					)}
					{result.url && (
						<>
							{" "}
							<a href={result.url} target="_blank" rel="noreferrer" className="underline">
								View post
							</a>
						</>
					)}
					{GRAPH_NOTE[result.graphImport] && <span className="text-muted-foreground"> · {GRAPH_NOTE[result.graphImport]}</span>}
				</p>
			)}
			{error && plan && <p className="text-xs text-destructive">{error}</p>}

			{index?.content !== undefined && (
				<>
					<div className="text-xs text-muted-foreground">
						Exact <span className="font-mono">index.md</span>
						{plan.target?.format === "notebook" ? " (front matter; the notebook carries the cells)" : ""} — private cells are left out.
					</div>
					<pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">{index.content}</pre>
				</>
			)}
		</div>
	);
}
