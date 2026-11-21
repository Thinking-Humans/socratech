/**
 * The notebook visualizer (owner, 2026-11-21): one voiced video of the whole
 * notebook, made by a background Claude Code + HyperFrames job.
 *   GET    → the job state (the panel polls while running)
 *   POST   {request?} → start: from scratch, or revise the last video per `request`
 *   DELETE → cancel the running job
 */
import { asBody, cancelNotebookVideo, journalRoute, notebookVideoState, startNotebookVideo } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(() => Response.json(notebookVideoState(id)));
}

export async function POST(req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(async () => {
		const body = asBody(await req.json().catch(() => ({})));
		const request = typeof body.request === "string" ? body.request : undefined;
		startNotebookVideo(id, { request });
		return Response.json(notebookVideoState(id));
	});
}

export async function DELETE(_req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(() => {
		cancelNotebookVideo(id);
		return Response.json(notebookVideoState(id));
	});
}
