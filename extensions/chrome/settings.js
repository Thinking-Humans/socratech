// Shared by popup, options and the service worker (docs/web-clip.md).
export const DEFAULTS = { server: "http://localhost:3000", token: "" };

export async function loadSettings() {
	const saved = await chrome.storage.local.get(["server", "token"]);
	return { ...DEFAULTS, ...saved };
}

export async function saveSettings(settings) {
	await chrome.storage.local.set({ server: settings.server.replace(/\/+$/, ""), token: settings.token.trim() });
}

/** Only loopback servers: the app's MCP endpoint answers nothing else. */
export function isLoopback(server) {
	try {
		const u = new URL(server);
		return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
	} catch {
		return false;
	}
}
