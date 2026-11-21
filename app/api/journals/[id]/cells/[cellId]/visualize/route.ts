/**
 * POST /api/journals/[id]/cells/[cellId]/visualize — build a 3b1b-style
 * interactive visual of the cell (V). Streams progress lines (text/plain);
 * the last is `@@done <newCellId>` or `@@failed <reason>`. Closing the
 * request cancels the build.
 */
import { assertVisualizable, journalRoute, journalVisualizeStream } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; cellId: string }> };

export async function POST(req: Request, { params }: Ctx) {
	const { id, cellId } = await params;
	return journalRoute(() => {
		assertVisualizable(id, cellId);
		return new Response(journalVisualizeStream(id, cellId, req.signal), {
			headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
		});
	});
}
