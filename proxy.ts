import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { MCP_PATH, mcpAuthorized } from "./src/server/mcp-access.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability.
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
	if (!desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
