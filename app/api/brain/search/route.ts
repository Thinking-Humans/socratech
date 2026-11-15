/** GET /api/brain/search?q=…&k=8&types=chunk,memory → { hits: BrainHit[] } — no model call. */
import { brainRoute, searchBrain } from "@/src/server";
import type { BrainRecordType } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	return brainRoute(async () => {
		const p = new URL(req.url).searchParams;
		const k = Math.min(50, Math.max(1, Number(p.get("k")) || 8));
		const types = p.get("types")?.split(",").filter((t): t is BrainRecordType => t === "chunk" || t === "memory");
		return Response.json({ hits: await searchBrain(p.get("q") ?? "", { k, ...(types?.length ? { types } : {}) }) });
	});
}
