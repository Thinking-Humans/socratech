/**
 * Google's OAuth loopback redirect for the YouTube upload connection. A page,
 * not an /api route: the API proxy refuses outside callers by design. The
 * one-time `state` (minted by POST /api/youtube) is the guard.
 */
import { completeYouTubeAuth } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function YouTubeCallback({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const q = await searchParams;
	const one = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
	let message = "YouTube is connected. You can close this tab and go back to Socratech.";
	let ok = true;
	if (one("error")) {
		ok = false;
		message = `Google said: ${one("error")}. Start again from Settings → Notebook video.`;
	} else {
		try {
			await completeYouTubeAuth(one("code"), one("state"));
		} catch (err) {
			ok = false;
			message = err instanceof Error ? err.message : String(err);
		}
	}
	return (
		<main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
			<div className="max-w-md rounded-xl border border-border p-6 text-center">
				<h1 className="mb-2 text-lg font-medium">{ok ? "Connected" : "Couldn't connect YouTube"}</h1>
				<p className="text-sm text-muted-foreground">{message}</p>
			</div>
		</main>
	);
}
