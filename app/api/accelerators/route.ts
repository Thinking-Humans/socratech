/**
 * Accelerators (Settings → Accelerators) — remote compute for notebooks.
 *   GET  → {accelerators, keys: {runpod, modal}, modalInstalled, sshHosts, pods}
 *   POST {kind, name, …} → {accelerator}
 */
import { acceleratorOverview, acceleratorRoute, asBody, createAccelerator } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return acceleratorRoute(() => Response.json(acceleratorOverview()));
}

export async function POST(req: Request) {
	return acceleratorRoute(async () => Response.json({ accelerator: createAccelerator(asBody(await req.json())) }));
}
