import { NextResponse, type NextRequest } from "next/server";
import { apiRequestRefusal } from "./src/server/desktop-access.ts";
import { MCP_PATH, mcpAuthorized } from "./src/server/mcp-access.ts";

/** Protects API methods, including SSE and spending/settings routes. The one
 * streamed document route enforces the identical all-method request policy
 * inside its handler, avoiding Next's silently truncated Proxy body clone.
 * No public callback or worker bypass: legitimate self-HTTP still needs the capability.
 * The ONE other capability (Claude integration, 2026-10-30): EXACTLY the
 * MCP endpoint, and only with its bearer token — required in every mode,
 * browser dev included, since the caller is an outside Claude client. */
export function proxy(request: NextRequest) {
	if (request.nextUrl.pathname === MCP_PATH) {
		if (mcpAuthorized(request.headers)) return NextResponse.next();
		return NextResponse.json(
			{ error: "The MCP endpoint requires its bearer token (Settings → Claude)." },
			{ status: 401, headers: { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" } },
		);
	}
	const refusal = apiRequestRefusal(request);
	if (refusal) {
		return NextResponse.json(
			{ error: refusal },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = {
	// Keep /api itself covered; exempt only the exact streamed endpoints (the
	// plugin document import, the journal media upload — both enforce the
	// same policy in-handler), not their subtrees. Must remain static literals.
	matcher: ["/api", "/api/((?!plugins/[^/]+/documents/markdown/?$|journals/[^/]+/media/?$).*)"],
};
