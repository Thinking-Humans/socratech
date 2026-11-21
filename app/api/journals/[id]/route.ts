/**
 * /api/journals/[id]
 *   GET                       the journal
 *   PATCH {title?, slug?, tags?}   metadata (slug pinned once published)
 *   DELETE                    remove the journal (published posts stay on the site)
 */
import { asBody, cancelNotebookVideo, deleteNotebook, journalRoute, parseMetaPatch, patchJournalMeta, requireJournal } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(() => Response.json({ journal: requireJournal(id) }));
}

export async function PATCH(req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(async () => Response.json({ journal: patchJournalMeta(id, parseMetaPatch(asBody(await req.json()))) }));
}

export async function DELETE(_req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(() => {
		// A running notebook-video job must not outlive (and recreate) the notebook.
		try {
			cancelNotebookVideo(id);
		} catch {
			// no such notebook → the delete below answers 404
		}
		return deleteNotebook(id) ? Response.json({ ok: true }) : Response.json({ error: "Not found", code: "not_found" }, { status: 404 });
	}
	);
}
