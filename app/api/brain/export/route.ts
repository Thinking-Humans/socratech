/** GET /api/brain/export?chunks=0&vectors=0 → `.brain.jsonl` download (brain/1). */
import { brainRoute, exportBrain } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	return brainRoute(() => {
		const p = new URL(req.url).searchParams;
		const body = exportBrain({ chunks: p.get("chunks") !== "0", vectors: p.get("vectors") !== "0" });
		const date = new Date().toISOString().slice(0, 10);
		return new Response(body, {
			headers: { "content-type": "application/x-ndjson; charset=utf-8", "content-disposition": `attachment; filename="second-brain-${date}.brain.jsonl"` },
		});
	});
}
