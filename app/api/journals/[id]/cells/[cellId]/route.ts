/**
 * /api/journals/[id]/cells/[cellId]
 *   PATCH {role?, source?, lang?, output?, publish?, ifUpdatedAt?}
 *         edit one cell; ifUpdatedAt (the cell's) → 409 when stale
 *   PATCH {toIndex}   move the cell
 *   DELETE            remove the cell (an extracted one leaves the graph too)
 */
import { asBody, deleteNotebookCell, journalRoute, moveJournalCell, parseCellPatch, patchJournalCell } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; cellId: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
	const { id, cellId } = await params;
	return journalRoute(async () => {
		const body = asBody(await req.json());
		if (body.toIndex !== undefined) {
			if (typeof body.toIndex !== "number" || !Number.isFinite(body.toIndex)) {
				return Response.json({ error: "toIndex must be a number", code: "invalid" }, { status: 400 });
			}
			return Response.json({ journal: moveJournalCell(id, cellId, body.toIndex) });
		}
		const { patch, ifUpdatedAt } = parseCellPatch(body);
		return Response.json({ journal: patchJournalCell(id, cellId, patch, ifUpdatedAt) });
	});
}

export async function DELETE(_req: Request, { params }: Ctx) {
	const { id, cellId } = await params;
	return journalRoute(() => Response.json({ journal: deleteNotebookCell(id, cellId) }));
}
