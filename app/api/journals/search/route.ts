/** GET /api/journals/search?q= — search every journal (Mod+K) → {hits}. */
import { journalRoute, searchAllJournals } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	const q = new URL(req.url).searchParams.get("q") ?? "";
	return journalRoute(() => Response.json({ hits: searchAllJournals(q) }));
}
