/**
 * POST /api/journals/[id]/cells/[cellId]/check — the agent's cross-check.
 *   {phase: "question"}                    → text stream: one check question
 *   {phase: "grade", question, answer}     → {journal, check} (saved on the rating)
 */
import { JournalError } from "@/src/core";
import { asBody, checkQuestionStream, gradeCheck, journalRoute } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; cellId: string }> };

export async function POST(req: Request, { params }: Ctx) {
	const { id, cellId } = await params;
	return journalRoute(async () => {
		const body = asBody(await req.json());
		if (body.phase === "question") {
			return new Response(checkQuestionStream(id, cellId), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
		}
		if (body.phase === "grade") {
			if (typeof body.question !== "string" || typeof body.answer !== "string") throw new JournalError("question and answer (strings) are required", "invalid");
			return Response.json(await gradeCheck(id, cellId, body.question, body.answer));
		}
		throw new JournalError('phase must be "question" or "grade"', "invalid");
	});
}
