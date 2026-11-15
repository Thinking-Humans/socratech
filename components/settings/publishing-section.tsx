"use client";

/**
 * Settings → Publishing (learn-in-public D10): where journals publish. A
 * local clone of the site repo; the bundle lands in <repo>/<content dir>,
 * is committed, and pushed after the learner confirms each publish. The
 * section PUT replaces the whole publishing record, so every commit sends
 * all fields (an emptied field drops its key → the default).
 */

import { useCallback, useEffect, useState } from "react";
import type { PublishingSettings, UserSettings } from "@/src/core";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { CommitInput, SettingsGroup, SettingsRow, ThinSelect, Toggle } from "./controls";

export function PublishingSection() {
	const [record, setRecord] = useState<PublishingSettings>({});
	const [error, setError] = useState<string | null>(null);

	const read = useCallback(async () => {
		try {
			const res = await fetch("/api/settings", { cache: "no-store" });
			const body = (await res.json()) as { settings: UserSettings | null };
			setRecord(body.settings?.publishing ?? {});
		} catch {
			setError("Could not load publishing settings.");
		}
	}, []);
	useEffect(() => {
		void read();
	}, [read]);
	useSettingsSaved((section) => {
		if (section === "publishing") void read();
	});

	const save = async (patch: Partial<Record<keyof PublishingSettings, string | boolean>>) => {
		const next: Record<string, unknown> = { ...record };
		for (const [k, v] of Object.entries(patch)) {
			if (v === "") delete next[k];
			else next[k] = v;
		}
		setError(null);
		const res = await fetch("/api/settings/publishing", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(next),
		});
		const body = (await res.json().catch(() => ({}))) as { settings?: UserSettings; error?: string };
		if (!res.ok) {
			setError(body.error ?? "Could not save publishing settings.");
			return false;
		}
		setRecord(body.settings?.publishing ?? {});
		notifySettingsSaved("publishing");
		return true;
	};

	return (
		<>
			<SettingsGroup label="Site" testid="publishing-site">
				<SettingsRow label="Site repo" hint="Absolute path of a local git clone. Empty = publishing off.">
					<CommitInput
						value={record.siteRepo ?? ""}
						placeholder="/home/me/blog"
						ariaLabel="Site repo path"
						testid="publishing-site-repo"
						onCommit={(v) => save({ siteRepo: v })}
					/>
				</SettingsRow>
				<SettingsRow label="Content folder" hint="Inside the repo. Posts land in <folder>/<date>-<slug>/.">
					<CommitInput
						value={record.contentDir ?? ""}
						placeholder="content/posts"
						ariaLabel="Content folder"
						onCommit={(v) => save({ contentDir: v })}
					/>
				</SettingsRow>
				<SettingsRow label="Site URL" hint="For post links, e.g. https://me.github.io/blog">
					<CommitInput
						value={record.baseUrl ?? ""}
						placeholder="https://…"
						ariaLabel="Site URL"
						onCommit={(v) => save({ baseUrl: v })}
					/>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup label="Bundle">
				<SettingsRow label="Format" hint="Markdown works anywhere; Notebook writes notebook.ipynb for notebook blogs.">
					<ThinSelect ariaLabel="Bundle format" value={record.format ?? "markdown"} onChange={(v) => void save({ format: v })}>
						<option value="markdown">Markdown</option>
						<option value="notebook">Notebook (.ipynb)</option>
					</ThinSelect>
				</SettingsRow>
				<SettingsRow label="Push after commit" hint="Off = commit locally; push yourself.">
					<Toggle label="Push after commit" checked={record.push ?? true} onChange={(v) => void save({ push: v })} />
				</SettingsRow>
			</SettingsGroup>
			{error && (
				<p className="mt-3 text-xs text-destructive" role="alert">
					{error}
				</p>
			)}
		</>
	);
}
