/**
 * /api/journals/[id]/publish (learn-in-public phase 4)
 *   GET               the dry-run plan: target dir, per-file status + content,
 *                     commit message, push target, blockers. Writes nothing.
 *   POST {confirmDir} write + commit (that dir only) + push, after the learner
 *                     confirmed the plan for exactly that dir (409 if it moved).
 */
import { asBody, journalRoute, planPublish, publishJournal, refuseCrossSite } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(async () => Response.json({ plan: await planPublish(id) }));
}

export async function POST(req: Request, { params }: Ctx) {
	const { id } = await params;
	const refused = refuseCrossSite(req);
	if (refused) return refused;
	return journalRoute(async () => {
		const body = asBody(await req.json());
		if (typeof body.confirmDir !== "string" || !body.confirmDir) {
			return Response.json({ error: "confirmDir (the previewed bundle dir) is required", code: "invalid" }, { status: 400 });
		}
		return Response.json({ result: await publishJournal(id, body.confirmDir) });
	});
}
