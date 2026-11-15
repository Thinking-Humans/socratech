import { connectClaudeResponse } from "@/src/server";

/**
 * Settings → Claude → Connect Claude (owner, 2026-11-16): register this
 * app's MCP endpoint with Claude Code and Claude Desktop, when found.
 * Behind the ordinary /api guard — only the app's own window reaches it.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	return connectClaudeResponse(request);
}
