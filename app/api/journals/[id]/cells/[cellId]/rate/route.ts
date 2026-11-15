/**
 * POST /api/journals/[id]/cells/[cellId]/rate {level: "own"|"helped"|"stuck"|null}
 * → {journal, prereqCellId?} — "stuck" adds (or reuses) the prerequisites
 * agent cell right above; the client runs it.
 */
import { JournalError, UNDERSTANDING_LEVELS, type UnderstandingLevel } from "@/src/core";
import { asBody, journalRoute, rateCell } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; cellId: string }> };

export async function POST(req: Request, { params }: Ctx) {
	const { id, cellId } = await params;
	return journalRoute(async () => {
		const { level } = asBody(await req.json());
		if (level !== null && !(UNDERSTANDING_LEVELS as readonly unknown[]).includes(level)) {
			throw new JournalError(`level must be one of ${UNDERSTANDING_LEVELS.join(", ")} or null`, "invalid");
		}
		return Response.json(rateCell(id, cellId, level as UnderstandingLevel | null));
	});
}
