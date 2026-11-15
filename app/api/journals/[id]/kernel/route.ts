/**
 * DELETE /api/journals/[id]/kernel — restart the journal's Python kernel
 * (drops its variables; run numbers start again at 1).
 */
import { journalRoute, restartJournalKernel } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(() => {
		restartJournalKernel(id);
		return Response.json({ ok: true });
	});
}
