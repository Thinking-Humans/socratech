/**
 * POST /api/journals/[id]/cells/[cellId]/flashcards — the agent drafts
 * flashcards from this cell → { drafts: [{name, question, answer}] }.
 * Saves nothing: the learner edits them and the Flashcards plugin stores
 * the ones they keep, in the deck they choose.
 */
import { draftCellFlashcards, journalRoute } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; cellId: string }> };

export async function POST(req: Request, { params }: Ctx) {
	const { id, cellId } = await params;
	return journalRoute(async () => Response.json({ drafts: await draftCellFlashcards(id, cellId, req.signal) }));
}
