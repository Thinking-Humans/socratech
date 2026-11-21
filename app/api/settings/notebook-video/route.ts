/**
 * Settings → Notebook video (owner, 2026-11-21).
 *   GET    → {taste, custom, defaultTaste, setup}
 *   PUT    {taste} → save the learner's taste/workflow skill
 *   DELETE → back to the shipped default taste
 *   POST   {action: "install"} → one-time install of the video tools
 */
import { asBody, installVideoTools, journalRoute, readVideoTaste, videoSetup, writeVideoTaste } from "@/src/server";
import { JournalError } from "@/src/core";

export const dynamic = "force-dynamic";

const view = () => {
	const t = readVideoTaste();
	return { taste: t.text, custom: t.custom, defaultTaste: t.defaultText, setup: videoSetup() };
};

export async function GET() {
	return journalRoute(() => Response.json(view()));
}

export async function PUT(req: Request) {
	return journalRoute(async () => {
		const { taste } = asBody(await req.json());
		if (typeof taste !== "string") throw new JournalError("taste must be text", "invalid");
		writeVideoTaste(taste);
		return Response.json(view());
	});
}

export async function DELETE() {
	return journalRoute(() => {
		writeVideoTaste(null);
		return Response.json(view());
	});
}

export async function POST(req: Request) {
	return journalRoute(async () => {
		const { action } = asBody(await req.json());
		if (action !== "install") throw new JournalError('Expected action: "install"', "invalid");
		try {
			await installVideoTools();
		} catch (err) {
			return Response.json({ ...view(), error: err instanceof Error ? err.message : String(err) }, { status: 500 });
		}
		return Response.json(view());
	});
}
