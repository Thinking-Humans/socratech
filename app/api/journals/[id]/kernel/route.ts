/**
 * The notebook's kernel.
 *   GET    → where it runs + state (off / connecting / ready / running / error), live output of the running cell
 *   POST   {action: "connect"}   start it now (cloud machines take minutes)
 *   POST   {action: "interrupt"} stop the running cell
 *   DELETE → restart: drop its variables (run numbers start again at 1) and release a cloud machine
 */
import { JournalError } from "@/src/core";
import { asBody, connectJournalKernel, interruptJournalKernel, journalKernelStatus, journalRoute, restartJournalKernel } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(() => Response.json(journalKernelStatus(id)));
}

export async function POST(req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(async () => {
		const { action } = asBody(await req.json());
		if (action === "connect") connectJournalKernel(id);
		else if (action === "interrupt") interruptJournalKernel(id);
		else throw new JournalError('Expected action: "connect" or "interrupt"', "invalid");
		return Response.json(journalKernelStatus(id));
	});
}

export async function DELETE(_req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(() => {
		restartJournalKernel(id);
		return Response.json({ ok: true });
	});
}
