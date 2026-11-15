/**
 * /api/journals — learn-in-public journals (docs/learn-in-public.md).
 *   GET              every journal's summary, newest activity first
 *   GET ?chatId=…    { journal } for that session, or { journal: null }
 *   POST {title, chatId?, slug?, tags?}   create (409 if the session has one)
 */
import { asBody, createJournal, journalRoute, parseCreateJournal, stores } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	return journalRoute(() => {
		const chatId = new URL(req.url).searchParams.get("chatId");
		if (chatId) return Response.json({ journal: stores.journalStore.findJournalByChat(chatId) });
		return Response.json({ journals: stores.journalStore.listJournals() });
	});
}

export async function POST(req: Request) {
	return journalRoute(async () => {
		const journal = createJournal(parseCreateJournal(asBody(await req.json())));
		return Response.json({ journal }, { status: 201 });
	});
}
