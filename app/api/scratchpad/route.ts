/**
 * /api/scratchpad — the Mod+P scratchpad's one text buffer.
 *   GET          { text }
 *   PUT {text}   replace it → { ok: true }
 */
import { asBody, journalRoute, readScratchpad, writeScratchpad } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return journalRoute(() => Response.json({ text: readScratchpad() }));
}

export async function PUT(req: Request) {
	return journalRoute(async () => {
		writeScratchpad(asBody(await req.json()));
		return Response.json({ ok: true });
	});
}
