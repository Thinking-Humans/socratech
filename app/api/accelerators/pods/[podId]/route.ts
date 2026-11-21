/** DELETE — terminate a RunPod pod the app created (it stops billing). */
import { acceleratorRoute, terminateRunPod } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ podId: string }> };

export async function DELETE(_req: Request, { params }: Ctx) {
	const { podId } = await params;
	return acceleratorRoute(async () => {
		await terminateRunPod(podId);
		return Response.json({ ok: true });
	});
}
