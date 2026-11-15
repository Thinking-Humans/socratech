/**
 * GET /api/journals/[id]/marimo — the notebook's marimo-clean report:
 * {checked, redefinitions: [{name, cellIds, reserved?}], unparsable:
 * [{cellId, error}]}. Python globals defined by two cells run fine here but
 * marimo refuses them (docs/learn-in-public.md "Marimo storage").
 */
import { journalMarimoCheck, journalRoute } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(async () => Response.json(await journalMarimoCheck(id)));
}
