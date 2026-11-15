/**
 * POST /api/journals/[id]/cells/[cellId]/ask {question} — stream the strong
 * model's answer about this cell (text/plain deltas). The finished answer is
 * saved as a private aside below the cell (journals-changed fires).
 */
import { asBody, journalAskStream, journalRoute } from "@/src/server";
import { JournalError } from "@/src/core";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; cellId: string }> };

export async function POST(req: Request, { params }: Ctx) {
	const { id, cellId } = await params;
	return journalRoute(async () => {
		const body = asBody(await req.json());
		if (typeof body.question !== "string") throw new JournalError("question (string) is required", "invalid");
		return new Response(journalAskStream(id, cellId, body.question), {
			headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
		});
	});
}
