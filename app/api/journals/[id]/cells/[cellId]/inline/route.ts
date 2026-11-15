/**
 * POST /api/journals/[id]/cells/[cellId]/inline
 *   {mode: explain|insert|ask, draft, role, lang?, selection, turns[]}
 * Inline ask while editing (Ctrl+L): stream the answer about the
 * highlighted passage (text/plain). Ephemeral — nothing is saved.
 */
import { asBody, journalInlineStream, journalRoute, parseInlineAsk } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; cellId: string }> };

export async function POST(req: Request, { params }: Ctx) {
	const { id, cellId } = await params;
	return journalRoute(async () => {
		const input = parseInlineAsk(asBody(await req.json()));
		return new Response(journalInlineStream(id, cellId, input, req.signal), {
			headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
		});
	});
}
