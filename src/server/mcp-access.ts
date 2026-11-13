/**
 * The Claude MCP endpoint's credential (Claude integration, 2026-10-30):
 * one bearer token in the auth store (auth.json, mode 0600) as
 * LH_MCP_TOKEN — minted on first read, rotated on demand. The proxy lets
 * EXACTLY /api/mcp through on this token (constant-time compare); every
 * other route keeps the desktop rule. Not an OAuth credential: a local
 * capability for the user's own Claude clients.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { authStore } from "../store/auth.ts";

export const MCP_TOKEN_VAR = "LH_MCP_TOKEN";
/** The one path the token opens. */
export const MCP_PATH = "/api/mcp";

const TOKEN_BYTES = 32;

/** The current token — minted (and persisted) on first read. */
export function mcpToken(): string {
	const existing = authStore.authVars()[MCP_TOKEN_VAR];
	if (existing && existing.length >= TOKEN_BYTES * 2) return existing;
	return rotateMcpToken();
}

/** Replace the token: every configured Claude client must re-add it. */
export function rotateMcpToken(): string {
	const token = randomBytes(TOKEN_BYTES).toString("hex");
	authStore.setAuthVar(MCP_TOKEN_VAR, token);
	return token;
}

/** Does this request carry the MCP bearer token? Never mints one: with no
 *  token stored, nothing is authorized. */
export function mcpAuthorized(headers: Headers, stored: string | undefined = authStore.authVars()[MCP_TOKEN_VAR]): boolean {
	if (!stored || stored.length < TOKEN_BYTES * 2) return false;
	const header = headers.get("authorization") ?? "";
	const match = /^Bearer\s+(\S+)$/i.exec(header);
	if (!match) return false;
	const supplied = Buffer.from(match[1]!);
	const wanted = Buffer.from(stored);
	return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}
