/**
 * POST /api/notes/ask {content, line} — stream Claude's answer to the
 * `/ask` on `line` (1-based) of the editor's current text (docs/notes-first.md N3).
 * text/plain deltas; 400 when the line is not an /ask or no model is set.
 */
import { askContext } from "@/src/core";
import { NoteError, askStream, noteRoute } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	return noteRoute(async () => {
		const body = (await req.json()) as Record<string, unknown>;
		if (typeof body.content !== "string" || typeof body.line !== "number") throw new NoteError("content (string) and line (number) are required", "invalid");
		const ctx = askContext(body.content, body.line);
		if (!ctx) throw new NoteError("That line is not an /ask.", "invalid");
		return new Response(askStream(ctx, req.signal), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
	});
}
