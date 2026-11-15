/**
 * /api/brain — the second-brain index (docs/brain-store.md).
 *   GET                         BrainStatus
 *   POST {action:"index", dir?} index / re-index a vault (default: the notes vault) — 202, runs in background
 *   POST {action:"remove", vault} forget a vault's chunks (memories stay)
 */
import { BrainError, brainRoute, brainStatus, indexVault, removeVault } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return brainRoute(() => Response.json(brainStatus()));
}

export async function POST(req: Request) {
	return brainRoute(async () => {
		const body = (await req.json()) as { action?: unknown; dir?: unknown; vault?: unknown };
		if (body.action === "index") {
			if (brainStatus().indexing) throw new BrainError("Already indexing.", "busy");
			const dir = typeof body.dir === "string" && body.dir.trim() ? body.dir.trim() : undefined;
			const run = indexVault(dir);
			// Fail fast on a bad folder; otherwise let it run (status polls progress).
			const early = await Promise.race([run.then(() => null, (e: unknown) => e), new Promise((r) => setTimeout(() => r(null), 50))]);
			if (early instanceof BrainError) throw early;
			run.catch(() => undefined);
			return Response.json(brainStatus(), { status: 202 });
		}
		if (body.action === "remove" && typeof body.vault === "string") {
			await removeVault(body.vault);
			return Response.json(brainStatus());
		}
		throw new BrainError('action must be "index" or "remove"', "invalid");
	});
}
