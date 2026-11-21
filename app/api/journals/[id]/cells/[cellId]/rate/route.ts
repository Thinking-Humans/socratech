/**
 * POST /api/journals/[id]/cells/[cellId]/rate {confidence: 0–100 | null}
 * → {journal, prereqCellId?} — snapped to the confidence stops; 0% adds (or
 * reuses) the prerequisites agent cell right above; the client runs it.
 */
import { JournalError } from "@/src/core";
import { asBody, journalRoute, rateCell } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; cellId: string }> };

export async function POST(req: Request, { params }: Ctx) {
	const { id, cellId } = await params;
	return journalRoute(async () => {
		const { confidence } = asBody(await req.json());
		if (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 100)) {
			throw new JournalError("confidence must be a number 0–100 or null", "invalid");
		}
		return Response.json(rateCell(id, cellId, confidence as number | null));
	});
}
