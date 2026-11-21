"use client";

/**
 * Where this notebook's code runs (owner, 2026-11-21): this machine or an
 * accelerator from Settings → Accelerators — an SSH server, a RunPod pod,
 * a Modal sandbox. Shows the kernel's state (connecting… / Python + GPU /
 * idle stop), connects ahead of the first run, and disconnects (which
 * releases a cloud machine).
 */

import { useEffect, useState } from "react";
import { CpuIcon, LoaderCircleIcon, PlugZapIcon, PowerIcon, Settings2Icon } from "lucide-react";
import { ACCELERATOR_KIND_LABEL, type Accelerator } from "@/src/core";
import { cn } from "@/lib/utils";
import { journalApi, type KernelView } from "@/components/journal/journal-api";
import { elapsedSince } from "@/components/journal/kernel-status";
import { useSettingsDialog } from "@/components/settings/settings-dialog";

export function ComputeBar({
	journalId,
	accelerator,
	kernel,
	refresh,
	onChange,
}: {
	journalId: string;
	/** The notebook's accelerator id (absent = this machine). */
	accelerator?: string;
	kernel: KernelView | null;
	refresh: () => Promise<void>;
	/** Persist the choice (PATCH meta) — the server restarts the kernel. */
	onChange: (accelerator: string | null) => Promise<void>;
}) {
	const [list, setList] = useState<Accelerator[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const settings = useSettingsDialog();
	const [, tick] = useState(0);

	useEffect(() => {
		let live = true;
		const load = () =>
			fetch("/api/accelerators", { cache: "no-store" })
				.then((r) => r.json())
				.then((d: { accelerators?: Accelerator[] }) => live && setList(d.accelerators ?? []))
				.catch(() => live && setList([]));
		void load();
		// Settings may add one while the notebook is open.
		const onFocus = () => void load();
		window.addEventListener("focus", onFocus);
		const t = setInterval(load, 30_000);
		return () => {
			live = false;
			window.removeEventListener("focus", onFocus);
			clearInterval(t);
		};
	}, []);
	// The idle countdown.
	useEffect(() => {
		if (!kernel?.idleStopAt) return;
		const t = setInterval(() => tick((n) => n + 1), 15_000);
		return () => clearInterval(t);
	}, [kernel?.idleStopAt]);

	const act = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		try {
			await fn();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
			void refresh();
		}
	};

	const remote = Boolean(accelerator);
	const acc = list?.find((a) => a.id === accelerator);
	const state = kernel?.state ?? "off";
	const gpus = kernel?.info?.gpus?.map((g) => g.split(",")[0]!.replace(/^NVIDIA (GeForce )?/, "")).join(", ");
	const idleMin = kernel?.idleStopAt ? Math.max(0, Math.ceil((Date.parse(kernel.idleStopAt) - Date.now()) / 60_000)) : null;

	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="journal-compute">
			<CpuIcon className={cn("size-3.5", remote ? "text-primary" : "")} aria-hidden />
			<select
				aria-label="Where this notebook's code runs"
				data-testid="journal-compute-select"
				value={accelerator ?? ""}
				disabled={busy || state === "running"}
				onChange={(e) => void act(() => onChange(e.target.value || null))}
				title={state === "running" ? "A cell is running" : "Switching machines resets this notebook's Python variables"}
				className="lh-input max-w-56 rounded-md border border-border bg-background px-1.5 py-0.5 text-xs outline-none"
			>
				<option value="">This machine</option>
				{list?.map((a) => (
					<option key={a.id} value={a.id}>
						{a.name} · {ACCELERATOR_KIND_LABEL[a.kind]}
					</option>
				))}
				{accelerator && list && !acc && <option value={accelerator}>(deleted accelerator)</option>}
			</select>

			{state === "connecting" && (
				<span className="flex items-center gap-1 text-foreground" data-testid="journal-compute-status">
					<LoaderCircleIcon className="size-3 animate-spin text-primary" />
					{kernel?.phase ?? "connecting"}…
				</span>
			)}
			{(state === "ready" || state === "running") && kernel?.info && (
				<span className="flex items-center gap-1" data-testid="journal-compute-status" title={kernel.info.cwd ? `Code runs in ${kernel.info.cwd}${kernel.info.host ? ` on ${kernel.info.host}` : ""}` : undefined}>
					<span className="size-1.5 rounded-full bg-success" aria-hidden />
					Python {kernel.info.python}
					{remote && kernel.info.host ? ` on ${kernel.info.host}` : ""}
					{gpus ? ` · ${gpus}` : remote ? " · no GPU" : ""}
					{state === "running" && kernel.running ? ` · running ${elapsedSince(kernel.running.startedAt)}` : ""}
					{idleMin !== null && state === "ready" ? ` · stops after ${idleMin} min idle` : ""}
				</span>
			)}
			{state === "error" && kernel?.error && (
				<span className="max-w-full truncate text-destructive" title={kernel.error} data-testid="journal-compute-error">
					couldn't connect: {kernel.error}
				</span>
			)}
			{kernel?.missingAccelerator && <span className="text-warning">its accelerator was deleted — runs on this machine</span>}

			{remote && acc && (state === "off" || state === "error") && (
				<button
					type="button"
					disabled={busy}
					onClick={() => void act(() => journalApi.connectKernel(journalId))}
					title={acc.kind === "ssh" ? "Start Python on the server now" : "Start the cloud machine now (it bills while up)"}
					className="flex items-center gap-1 rounded-full border border-primary/50 px-2 py-0.5 uppercase tracking-wide text-primary hover:bg-primary/10 disabled:opacity-50"
					data-testid="journal-compute-connect"
				>
					<PlugZapIcon className="size-3" /> Connect
				</button>
			)}
			{remote && (state === "connecting" || state === "ready") && (
				<button
					type="button"
					disabled={busy}
					onClick={() => void act(() => journalApi.restartKernel(journalId))}
					title={acc && acc.kind !== "ssh" ? "Disconnect and shut the cloud machine down (variables are lost)" : "Disconnect (variables are lost)"}
					className="flex items-center gap-1 rounded-full border border-border/80 px-2 py-0.5 uppercase tracking-wide hover:text-foreground disabled:opacity-50"
					data-testid="journal-compute-disconnect"
				>
					<PowerIcon className="size-3" /> {state === "connecting" ? "Cancel" : "Disconnect"}
				</button>
			)}
			<button type="button" onClick={() => settings?.open("accelerators")} className="rounded p-0.5 hover:text-foreground" title="Manage accelerators" aria-label="Manage accelerators">
				<Settings2Icon className="size-3.5" />
			</button>
			{remote && (state === "ready" || state === "running") && (
				<span className="basis-full text-[11px] text-muted-foreground/80">Files on this machine aren&apos;t copied there — read data from the server (or download it in a cell).</span>
			)}
			{error && <span className="basis-full text-destructive">{error}</span>}
		</div>
	);
}
