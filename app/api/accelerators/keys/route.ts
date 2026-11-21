/**
 * PUT {runpodApiKey?, modalTokenId?, modalTokenSecret?} — a string sets, null clears.
 * Stored 0600 beside auth.json; only {runpod, modal} booleans ever come back.
 */
import { acceleratorRoute, asBody, setAcceleratorKeys } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
	return acceleratorRoute(async () => Response.json({ keys: setAcceleratorKeys(asBody(await req.json())) }));
}
