/**
 * POST /api/journals/[id]/cells/[cellId]/extract — read this cell into the
 * graph now (an edited cell replaces its earlier contribution)
 * → {journal, outcome, stats?}.
 */
import { extractCell, journalRoute } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; cellId: string }> };

export async function POST(_req: Request, { params }: Ctx) {
	const { id, cellId } = await params;
	return journalRoute(async () => Response.json(await extractCell(id, cellId)));
}
