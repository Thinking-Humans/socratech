/** POST /api/brain/consolidate {chatId} | {journalId} — run consolidation now (normally automatic on idle). */
import { BrainError, brainRoute, consolidateJournal, consolidateSession } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	return brainRoute(async () => {
		const body = (await req.json()) as { chatId?: unknown; journalId?: unknown };
		if (typeof body.chatId === "string") return Response.json({ result: await consolidateSession(body.chatId) });
		if (typeof body.journalId === "string") return Response.json({ result: await consolidateJournal(body.journalId) });
		throw new BrainError("chatId or journalId is required", "invalid");
	});
}
