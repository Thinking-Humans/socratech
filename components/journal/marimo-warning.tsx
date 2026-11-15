"use client";

/**
 * marimo-clean warning under a Python cell (docs/learn-in-public.md "Marimo
 * storage"): the notebook runs fine here, but marimo refuses a global that
 * two cells both define. One request per notebook at a time (each spawns
 * python3 server-side); every Python cell of that notebook shares it.
 * Refreshes when this cell's code or run number changes.
 */

import { useEffect, useState } from "react";
import { isPythonCell, type JournalCell, type MarimoRedefinition } from "@/src/core";
import { journalApi, type MarimoCleanReport } from "@/components/journal/journal-api";

const SHARE_MS = 1500;
const inflight = new Map<string, { at: number; report: Promise<MarimoCleanReport | null> }>();

function marimoReport(journalId: string): Promise<MarimoCleanReport | null> {
	const hit = inflight.get(journalId);
	if (hit && Date.now() - hit.at < SHARE_MS) return hit.report;
	const report = journalApi.marimoCheck(journalId).catch(() => null);
	inflight.set(journalId, { at: Date.now(), report });
	return report;
}

export function MarimoWarning({ journalId, cell }: { journalId: string; cell: JournalCell }) {
	const python = isPythonCell(cell);
	const [clashes, setClashes] = useState<MarimoRedefinition[]>([]);
	useEffect(() => {
		if (!python) return;
		let live = true;
		void marimoReport(journalId).then((r) => {
			if (live) setClashes(r?.redefinitions.filter((d) => d.cellIds.includes(cell.id)) ?? []);
		});
		return () => {
			live = false;
		};
	}, [python, journalId, cell.id, cell.source, cell.executionCount]);
	if (!python || clashes.length === 0) return null;
	const names = clashes.map((d) => (d.reserved ? `${d.name} (the notebook's marimo import)` : d.name)).join(", ");
	return (
		<div className="mt-1 text-xs text-warning" data-testid="journal-marimo-warning">
			marimo: <code>{names}</code> {clashes.length === 1 ? "is" : "are"} defined in another cell too. It runs here, but marimo refuses
			redefinitions: rename one, or prefix it with <code>_</code> to keep it cell-local.
		</div>
	);
}
