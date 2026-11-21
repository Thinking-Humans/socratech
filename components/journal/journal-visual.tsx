"use client";

/**
 * A generated 3b1b-style visual (`![title](media/x.html)` on its own line):
 * the HTML is fetched as text and run through the demo card's sandboxed
 * iframe (srcdoc, allow-scripts, opaque origin). The media route itself
 * serves HTML under a script-less CSP sandbox, so it never runs from src.
 */

import { useEffect, useState } from "react";
import { DemoOutputCard } from "@/components/artifacts/demo-card";
import { journalMediaUrl } from "@/src/core";

export function JournalVisual({ journalId, name, title }: { journalId: string; name: string; title: string }) {
	const [html, setHtml] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		setHtml(null);
		setError(null);
		fetch(journalMediaUrl(journalId, name), { cache: "force-cache" })
			.then(async (res) => {
				if (!res.ok) throw new Error(`visual missing (${res.status})`);
				const text = await res.text();
				if (live) setHtml(text);
			})
			.catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
		return () => {
			live = false;
		};
	}, [journalId, name]);

	if (error) return <div className="my-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">Visual unavailable: {error}</div>;
	if (html === null) return <div className="my-2 h-40 animate-pulse rounded-xl border border-border bg-muted/30" data-testid="journal-visual-loading" />;
	return (
		// Clicks inside the visual must not open the cell editor.
		<div className="my-2" data-testid="journal-visual" onClick={(e) => e.stopPropagation()}>
			<DemoOutputCard output={{ title: title || "Visual", html, tested: true }} />
		</div>
	);
}
