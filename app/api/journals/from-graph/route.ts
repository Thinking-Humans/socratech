/**
 * POST /api/journals/from-graph {mode: "teach"|"practice", topic, propositions?}
 * — launch a notebook from the graph (core/notebook-from-graph.ts)
 * → 201 {journal, runCellId?}; the client runs runCellId's agent cell.
 */
import { JournalError, parseNotebookLaunch } from "@/src/core";
import { journalRoute, launchNotebookFromGraph } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	return journalRoute(async () => {
		let input;
		try {
			input = parseNotebookLaunch(await req.json());
		} catch (err) {
			throw new JournalError(err instanceof Error ? err.message : String(err), "invalid");
		}
		return Response.json(await launchNotebookFromGraph(input), { status: 201 });
	});
}
