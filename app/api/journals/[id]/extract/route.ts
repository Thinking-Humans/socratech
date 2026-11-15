/**
 * POST /api/journals/[id]/extract — read this notebook into the graph now
 * (the notebook is the graph's unit; an edited notebook replaces its
 * earlier contribution) → {journal, outcome, stats?}.
 */
import { extractNotebook, journalRoute } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(async () => Response.json(await extractNotebook(id)));
}
