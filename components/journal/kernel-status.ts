"use client";

/**
 * The notebook kernel's live status (where it runs, connecting / running,
 * the running cell's output so far). Polls fast while something is
 * happening, slowly otherwise — cheap: one in-memory read on the server.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { journalApi, type KernelView } from "@/components/journal/journal-api";

export function useKernelStatus(journalId: string | undefined, busy: boolean): { kernel: KernelView | null; refresh: () => Promise<void> } {
	const [kernel, setKernel] = useState<KernelView | null>(null);
	const live = useRef(journalId);
	live.current = journalId;
	const refresh = useCallback(async () => {
		const id = live.current;
		if (!id) return;
		try {
			const k = await journalApi.kernelStatus(id);
			if (live.current === id) setKernel(k);
		} catch {
			/* a deleted notebook / server restart — the next poll tries again */
		}
	}, []);
	useEffect(() => {
		setKernel(null);
		void refresh();
	}, [journalId, refresh]);
	const fast = busy || kernel?.state === "connecting" || kernel?.state === "running";
	useEffect(() => {
		if (!journalId) return;
		const t = setInterval(() => void refresh(), fast ? 1000 : 10_000);
		return () => clearInterval(t);
	}, [journalId, fast, refresh]);
	return { kernel, refresh };
}

export function elapsedSince(iso: string | undefined, now = Date.now()): string {
	if (!iso) return "";
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
