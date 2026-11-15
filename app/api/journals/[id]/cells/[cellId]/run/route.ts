/**
 * POST /api/journals/[id]/cells/[cellId]/run — run a code cell (python:
 * the journal's persistent kernel; cpp: compile + run). Records output and
 * run number on the cell → {journal, run: {output, ok, executionCount, ms}}.
 */
import { journalRoute, runJournalCell } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; cellId: string }> };

export async function POST(_req: Request, { params }: Ctx) {
	const { id, cellId } = await params;
	return journalRoute(async () => Response.json(await runJournalCell(id, cellId)));
}
