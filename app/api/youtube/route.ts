/**
 * YouTube connection (Settings → Notebook video).
 *   GET    → {configured, connected, clientId?}
 *   PUT    {clientId, clientSecret} → save the learner's Google OAuth client
 *   POST   {action: "connect"} → {url}: the Google consent page to open
 *   DELETE → forget the connection (keeps the client)
 */
import { JournalError } from "@/src/core";
import { asBody, disconnectYouTube, journalRoute, setYouTubeClient, youtubeAuthUrl, youtubeStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return journalRoute(() => Response.json(youtubeStatus()));
}

export async function PUT(req: Request) {
	return journalRoute(async () => {
		const { clientId, clientSecret } = asBody(await req.json());
		if (typeof clientId !== "string" || typeof clientSecret !== "string") throw new JournalError("clientId and clientSecret are required", "invalid");
		setYouTubeClient(clientId, clientSecret);
		return Response.json(youtubeStatus());
	});
}

export async function POST(req: Request) {
	return journalRoute(async () => {
		const { action } = asBody(await req.json());
		if (action !== "connect") throw new JournalError('Expected action: "connect"', "invalid");
		// The loopback origin the app is served on: Google's Desktop clients accept any port.
		return Response.json({ url: youtubeAuthUrl(new URL(req.url).origin) });
	});
}

export async function DELETE() {
	return journalRoute(() => {
		disconnectYouTube();
		return Response.json(youtubeStatus());
	});
}
