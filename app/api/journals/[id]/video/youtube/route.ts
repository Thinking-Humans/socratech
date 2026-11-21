/**
 * POST /api/journals/[id]/video/youtube {title, description, privacy}
 * → the video state with its YouTube upload. Only from the upload dialog,
 * after the learner confirmed title and privacy.
 */
import { JournalError } from "@/src/core";
import { YOUTUBE_PRIVACY, asBody, journalRoute, notebookVideoState, uploadNotebookVideo, type YouTubePrivacy } from "@/src/server";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
	const { id } = await params;
	return journalRoute(async () => {
		const { title, description, privacy } = asBody(await req.json());
		if (typeof title !== "string" || typeof description !== "string" || !(YOUTUBE_PRIVACY as readonly unknown[]).includes(privacy)) {
			throw new JournalError("title, description and privacy (private / unlisted / public) are required", "invalid");
		}
		await uploadNotebookVideo(id, { title, description, privacy: privacy as YouTubePrivacy });
		return Response.json(notebookVideoState(id));
	});
}
