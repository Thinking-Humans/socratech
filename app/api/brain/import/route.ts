/** POST /api/brain/import?name=<file name>, body = file text (.brain.jsonl, mem0 or supermemory JSON). */
import { brainRoute, importBrain } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	return brainRoute(async () => {
		const name = new URL(req.url).searchParams.get("name")?.slice(0, 200) || "import";
		return Response.json(await importBrain(await req.text(), name));
	});
}
