import { handleMcpRequest } from "@/src/server";

/**
 * The gym's MCP endpoint (Claude integration, 2026-10-30): streamable
 * HTTP for the user's own Claude clients. The proxy admits this path only
 * with its bearer token; src/server/mcp.ts serves it.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	return handleMcpRequest(request);
}

export async function GET(request: Request) {
	return handleMcpRequest(request);
}

export async function DELETE(request: Request) {
	return handleMcpRequest(request);
}
