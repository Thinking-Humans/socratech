/**
 * /api/notes — the markdown vault (docs/notes-first.md).
 *   GET                    { notes: NoteSummary[] }
 *   GET ?path=…            { note: NoteFile | null }
 *   GET ?daily=YYYY-MM-DD  { note } — that day's note, created when missing ("today" ok)
 *   PUT {path, content, ifMtime?}  { note } — 409 when the file changed on disk
 */
import { NoteError, brainNoteSaved, ensureDailyNote, listNotes, noteRoute, readNote, today, writeNote } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	return noteRoute(() => {
		const params = new URL(req.url).searchParams;
		const daily = params.get("daily");
		if (daily) return Response.json({ note: ensureDailyNote(daily === "today" ? today() : daily) });
		const path = params.get("path");
		if (path) return Response.json({ note: readNote(path) });
		return Response.json({ notes: listNotes() });
	});
}

export async function PUT(req: Request) {
	return noteRoute(async () => {
		const body = (await req.json()) as Record<string, unknown>;
		if (typeof body.path !== "string" || typeof body.content !== "string") throw new NoteError("path and content are required strings", "invalid");
		const ifMtime = typeof body.ifMtime === "number" ? body.ifMtime : undefined;
		const note = writeNote(body.path, body.content, ifMtime);
		brainNoteSaved();
		return Response.json({ note });
	});
}
