/**
 * POST /api/journals/[id]/cells {role, source?, lang?, output?, publish?, afterId?}
 * Adds one cell (after afterId, else at the end). publish defaults by role.
 * POST {restore: <cell>, index} puts a deleted cell back (notebook undo).
 */
import { addJournalCell, asBody, journalRoute, parseNewCell, parseRestoreCell, restoreJournalCell } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return journalRoute(async () => {
		const body = asBody(await req.json());
		const restore = parseRestoreCell(body);
		if (restore) return Response.json({ journal: restoreJournalCell(id, restore.cell, restore.index) }, { status: 201 });
		const { init, afterId } = parseNewCell(body);
		return Response.json({ journal: addJournalCell(id, init, afterId) }, { status: 201 });
	});
}
