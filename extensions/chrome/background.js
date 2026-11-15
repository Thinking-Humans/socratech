// Service worker: capture the tab, hand it to Socratech's MCP endpoint
// (tool import_page_as_notebook), open the new notebook. Runs here, not in
// the popup, so closing the popup does not cancel a clip.
import { FALLBACK_SERVERS, isLoopback, loadSettings, saveSettings } from "./settings.js";

const MAX_HTML_CHARS = 1_900_000;

/** Runs in the page (isolated world, after vendor/Readability.js). */
function capturePage() {
	const url = location.href;
	let title = document.title;
	let html = "";
	try {
		const article = new Readability(document.cloneNode(true)).parse();
		if (article?.content) {
			html = article.content;
			title = article.title || title;
		}
	} catch {
		/* fall back to the whole body */
	}
	if (!html) html = document.body?.innerHTML ?? "";
	return { url, title, html };
}

async function capture(tabId) {
	await chrome.scripting.executeScript({ target: { tabId }, files: ["vendor/Readability.js"] });
	const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: capturePage });
	if (!result?.result) throw new Error("Could not read this page.");
	return result.result;
}

async function rpc(server, token, method, params) {
	const res = await fetch(`${server}/api/mcp`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
	});
	if (res.status === 401) throw new Error("Socratech refused the token. Press Connect Claude in Settings → Claude again.");
	if (!res.ok) throw new Error(`Socratech answered HTTP ${res.status}.`);
	const body = await res.json();
	if (body.error) throw new Error(body.error.message ?? "MCP error");
	return body;
}

/** Settings → Claude → Connect Claude: save the token only if this server accepts it. */
async function connect(server, token) {
	if (!isLoopback(server)) throw new Error("Only a Socratech on this computer can connect.");
	const body = await rpc(server, token, "tools/list", {});
	if (!(body.result?.tools ?? []).some((t) => t.name === "import_page_as_notebook")) throw new Error("This server has no web clip tool — update Socratech.");
	await saveSettings({ server, token });
	return { ok: true };
}

async function callTool(server, token, args) {
	const body = await rpc(server, token, "tools/call", { name: "import_page_as_notebook", arguments: args });
	const textOut = (body.result?.content ?? []).map((c) => c.text).join("\n");
	if (body.result?.isError) throw new Error(textOut || "The clip was refused.");
	const [first, ...rest] = textOut.split("\n");
	return { ...JSON.parse(first), message: rest.join("\n") };
}

async function clip(tabId) {
	const { server, token } = await loadSettings();
	if (!token) throw new Error("Not set up: in Socratech, open Settings → Claude and press Connect Claude.");
	const page = await capture(tabId);
	if (!/^https?:/.test(page.url)) throw new Error("Only http(s) pages can be clipped.");
	const html = page.html.length > MAX_HTML_CHARS ? page.html.slice(0, MAX_HTML_CHARS) : page.html;
	const args = { url: page.url, title: page.title, html };

	const servers = [server, ...FALLBACK_SERVERS.filter((s) => s !== server)].filter(isLoopback);
	let lastError;
	for (const s of servers) {
		try {
			const result = await callTool(s, token, args);
			await chrome.tabs.create({ url: `${s}${result.path}` });
			return { ok: true, ...result };
		} catch (err) {
			lastError = err;
			// A server that answered (token/refusal) is the right one — stop there.
			if (!(err instanceof TypeError)) break;
		}
	}
	throw lastError ?? new Error("Socratech is not running.");
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
	if (msg?.type === "connect") {
		// Only from our content script, and only for the page it runs in.
		if (sender.id !== chrome.runtime.id || !sender.url || new URL(sender.url).origin !== msg.server) return;
		connect(msg.server, String(msg.token)).then(reply, (err) => reply({ ok: false, error: String(err.message ?? err) }));
		return true;
	}
	if (msg?.type !== "clip") return;
	clip(msg.tabId).then(reply, (err) => reply({ ok: false, error: err instanceof TypeError ? "Socratech is not running (no answer on localhost)." : String(err.message ?? err) }));
	return true; // async reply
});
