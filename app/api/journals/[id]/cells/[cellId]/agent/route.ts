/**
 * POST /api/journals/[id]/cells/[cellId]/agent — run an agent cell: stream
 * the model's answer (text/plain deltas); the finished answer is saved as
 * the cell's output (journals-changed fires).
 */
import { journalAgentStream, journalRoute } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; cellId: string }> };

export async function POST(_req: Request, { params }: Ctx) {
	const { id, cellId } = await params;
	return journalRoute(
		() =>
			new Response(journalAgentStream(id, cellId), {
				headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
			}),
	);
}
