/**
 *   PUT    {…fields} → {accelerator}   edit (kind stays)
 *   DELETE           → {ok}            notebooks using it fall back to this machine
 *   POST   {action: "test"} → {ok, detail}  SSH: starts Python there; RunPod / Modal: checks the key only
 */
import { AcceleratorError } from "@/src/core";
import { acceleratorRoute, asBody, deleteAccelerator, testAccelerator, updateAccelerator } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Ctx) {
	const { id } = await params;
	return acceleratorRoute(async () => Response.json({ accelerator: updateAccelerator(id, asBody(await req.json())) }));
}

export async function DELETE(_req: Request, { params }: Ctx) {
	const { id } = await params;
	return acceleratorRoute(() => Response.json({ ok: deleteAccelerator(id) }));
}

export async function POST(req: Request, { params }: Ctx) {
	const { id } = await params;
	return acceleratorRoute(async () => {
		const { action } = asBody(await req.json());
		if (action !== "test") throw new AcceleratorError('Expected action: "test"');
		return Response.json(await testAccelerator(id));
	});
}
