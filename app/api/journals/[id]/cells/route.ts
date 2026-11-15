/**
 * POST /api/journals/[id]/cells {role, source?, lang?, output?, publish?, afterId?}
 * Adds one cell (after afterId, else at the end). publish defaults by role.
 */
import { addJournalCell, asBody, journalRoute, parseNewCell } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return journalRoute(async () => {
		const { init, afterId } = parseNewCell(asBody(await req.json()));
		return Response.json({ journal: addJournalCell(id, init, afterId) }, { status: 201 });
	});
}
