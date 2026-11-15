/**
 * /api/brain/memories
 *   GET              { memories: BrainRecord[] } newest first
 *   DELETE ?id=…     remove one memory
 */
import { BrainError, brainRoute, deleteMemory, listMemories } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return brainRoute(() => Response.json({ memories: listMemories() }));
}

export async function DELETE(req: Request) {
	return brainRoute(async () => {
		const id = new URL(req.url).searchParams.get("id");
		if (!id) throw new BrainError("id is required", "invalid");
		await deleteMemory(id);
		return Response.json({ ok: true });
	});
}
