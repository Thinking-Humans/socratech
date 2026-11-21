/**
 * YouTube upload for notebook videos (owner, 2026-11-21). The learner brings
 * their own Google OAuth client (Desktop type) — Settings → Notebook video.
 * OAuth: loopback redirect to the app's /youtube/callback PAGE (the /api
 * proxy refuses outside callers on purpose), guarded by a one-time `state`.
 * Secrets live beside auth.json in youtube-auth.json (0600), never in
 * settings.json. Every upload is the learner's explicit, confirmed action.
 *
 * Google: uploads from unverified API projects are locked to PRIVATE until
 * the project passes YouTube's audit — the UI says so.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import { JournalError } from "../core/journal.ts";

const FILE = path.join(/* turbopackIgnore: true */ path.dirname(AUTH_FILE), "youtube-auth.json");
const SCOPE = "https://www.googleapis.com/auth/youtube.upload";
export const YOUTUBE_PRIVACY = ["private", "unlisted", "public"] as const;
export type YouTubePrivacy = (typeof YOUTUBE_PRIVACY)[number];

interface Stored {
	clientId?: string;
	clientSecret?: string;
	refreshToken?: string;
	connectedAt?: string;
}

function read(): Stored {
	try {
		return JSON.parse(fs.readFileSync(FILE, "utf8")) as Stored;
	} catch {
		return {};
	}
}

function write(next: Stored): void {
	fs.mkdirSync(path.dirname(FILE), { recursive: true });
	const tmp = `${FILE}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(next, null, "\t"), { mode: 0o600 });
	fs.renameSync(tmp, FILE);
}

export function youtubeStatus(): { configured: boolean; connected: boolean; clientId?: string; connectedAt?: string } {
	const s = read();
	return { configured: Boolean(s.clientId && s.clientSecret), connected: Boolean(s.refreshToken), ...(s.clientId ? { clientId: s.clientId } : {}), ...(s.connectedAt ? { connectedAt: s.connectedAt } : {}) };
}

/** Save the OAuth client (a new client drops the old connection). */
export function setYouTubeClient(clientId: string, clientSecret: string): void {
	if (!clientId.trim() || !clientSecret.trim()) throw new JournalError("Client ID and secret are both required.", "invalid");
	const s = read();
	const same = s.clientId === clientId.trim();
	write({ clientId: clientId.trim(), clientSecret: clientSecret.trim(), ...(same && s.refreshToken ? { refreshToken: s.refreshToken, connectedAt: s.connectedAt } : {}) });
}

export function disconnectYouTube(): void {
	const s = read();
	write({ clientId: s.clientId, clientSecret: s.clientSecret });
}

// One-time OAuth states → their redirect URI (10 min).
type Pending = Map<string, { redirectUri: string; expires: number }>;
function pending(): Pending {
	const g = globalThis as typeof globalThis & { __lhYouTubeOAuth?: Pending };
	return (g.__lhYouTubeOAuth ??= new Map());
}

/** The Google consent URL; `origin` is the app's own (loopback) origin. */
export function youtubeAuthUrl(origin: string): string {
	const s = read();
	if (!s.clientId || !s.clientSecret) throw new JournalError("Add your Google OAuth client first.", "invalid");
	const state = randomBytes(24).toString("hex");
	const redirectUri = `${origin}/youtube/callback`;
	const now = Date.now();
	for (const [k, v] of pending()) if (v.expires < now) pending().delete(k);
	pending().set(state, { redirectUri, expires: now + 10 * 60_000 });
	const q = new URLSearchParams({
		client_id: s.clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: SCOPE,
		access_type: "offline",
		prompt: "consent",
		state,
	});
	return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function token(params: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; error?: string; error_description?: string }> {
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params),
	});
	return (await res.json()) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
}

/** The callback page: trade the code for a refresh token. */
export async function completeYouTubeAuth(code: string, state: string): Promise<void> {
	const p = pending().get(state);
	pending().delete(state);
	if (!p || p.expires < Date.now()) throw new Error("This sign-in link expired or was already used. Start again from Settings.");
	const s = read();
	const r = await token({ code, client_id: s.clientId ?? "", client_secret: s.clientSecret ?? "", redirect_uri: p.redirectUri, grant_type: "authorization_code" });
	if (!r.refresh_token) throw new Error(r.error_description ?? r.error ?? "Google returned no refresh token.");
	write({ ...s, refreshToken: r.refresh_token, connectedAt: new Date().toISOString() });
}

async function accessToken(): Promise<string> {
	const s = read();
	if (!s.refreshToken) throw new JournalError("Connect YouTube first (Settings → Notebook video).", "invalid");
	const r = await token({ refresh_token: s.refreshToken, client_id: s.clientId ?? "", client_secret: s.clientSecret ?? "", grant_type: "refresh_token" });
	if (!r.access_token) throw new JournalError(`YouTube sign-in failed: ${r.error_description ?? r.error ?? "no access token"} — reconnect in Settings.`, "invalid");
	return r.access_token;
}

/** Resumable upload of a local MP4 → the video's id and URL. */
export async function uploadToYouTube(file: string, meta: { title: string; description: string; privacy: YouTubePrivacy }): Promise<{ id: string; url: string }> {
	if (!YOUTUBE_PRIVACY.includes(meta.privacy)) throw new JournalError("privacy must be private, unlisted or public", "invalid");
	const title = meta.title.trim().slice(0, 100);
	if (!title) throw new JournalError("A title is required.", "invalid");
	const size = fs.statSync(file).size;
	const auth = await accessToken();
	const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth}`,
			"Content-Type": "application/json; charset=UTF-8",
			"X-Upload-Content-Type": "video/mp4",
			"X-Upload-Content-Length": String(size),
		},
		body: JSON.stringify({
			snippet: { title, description: meta.description.slice(0, 5000), categoryId: "27" /* Education */ },
			status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false },
		}),
	});
	const session = init.headers.get("location");
	if (!init.ok || !session) throw new JournalError(`YouTube refused the upload: ${(await init.text()).slice(0, 300)}`, "invalid");
	const put = await fetch(session, {
		method: "PUT",
		headers: { "Content-Type": "video/mp4", "Content-Length": String(size) },
		body: fs.readFileSync(file),
	});
	const body = (await put.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
	if (!put.ok || !body.id) throw new JournalError(`YouTube upload failed: ${body.error?.message ?? put.status}`, "invalid");
	return { id: body.id, url: `https://youtu.be/${body.id}` };
}
