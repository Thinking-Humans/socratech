/**
 * POST /api/journals/[id]/media — upload one image / video for a markdown
 * cell. Raw body; the original file name rides in `x-file-name`
 * (URI-encoded). → {name, markdown, bytes}.
 *
 * Exempt from proxy.ts (its body clone truncates large uploads), so the
 * identical API policy runs here first, before any body work.
 */
import { apiRequestRefusal, journalRoute, saveJournalMedia } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const refusal = (req: Request) => {
	const error = apiRequestRefusal(req);
	return error ? Response.json({ error }, { status: 403, headers: { "Cache-Control": "no-store" } }) : undefined;
};

export async function POST(req: Request, { params }: Ctx) {
	const denied = refusal(req);
	if (denied) return denied;
	const { id } = await params;
	return journalRoute(async () => {
		const raw = req.headers.get("x-file-name") ?? "";
		let original = raw;
		try {
			original = decodeURIComponent(raw);
		} catch {
			/* keep raw */
		}
		return Response.json(await saveJournalMedia(id, original, req.body));
	});
}

export async function GET(req: Request) {
	return refusal(req) ?? new Response(null, { status: 405 });
}
