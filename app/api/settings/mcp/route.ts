import { mcpToken, rotateMcpToken } from "@/src/server";

/**
 * The Claude section's credential (Claude integration, 2026-10-30): GET
 * reads the MCP bearer token (minting it on first read), POST rotates it.
 * Behind the ordinary /api guard — only the app's own window reaches it.
 */
export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ token: mcpToken() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST() {
	return Response.json({ token: rotateMcpToken() }, { headers: { "Cache-Control": "no-store" } });
}
