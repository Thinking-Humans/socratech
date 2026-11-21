/** POST — install (or upgrade) the Modal SDK into the app's own venv. → {modalInstalled} */
import { acceleratorRoute, installModal } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	return acceleratorRoute(async () => Response.json({ modalInstalled: await installModal() }));
}
