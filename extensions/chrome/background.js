// Service worker: capture the tab, hand it to Socratech's MCP endpoint
// (tool import_page_as_notebook), open the new notebook. Runs here, not in
// the popup, so closing the popup does not cancel a clip.
import { isLoopback, loadSettings, saveSettings } from "./settings.js";



const MAX_HTML_CHARS = 1_900_000;

/** Runs in the page (MAIN world, after vendor/Readability.js). */
function capturePage() {
	const url = location.href;
	let title = document.title;
	let html = "";
	try {
		// keepClasses: code blocks carry their language as class="language-…".
		const doc = document.cloneNode(true);
		// Code inside web components' shadow roots (MDN's <mdn-code-example>)
		// is not cloned — copy its <pre> blocks into the cloned host. The
		// clone keeps element order, so the two lists line up.
		const originals = document.querySelectorAll("*");
		const copies = doc.querySelectorAll("*");
		originals.forEach((el, i) => {
			const pres = el.shadowRoot?.querySelectorAll("pre");
			if (pres?.length && copies[i]) copies[i].innerHTML = [...pres].map((p) => p.outerHTML).join("");
		});
		// A heading alone in a wrapper div (Wikipedia's div.mw-heading, with
		// its [edit] link) gets dropped by Readability — unwrap it first.
		for (const h of doc.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
			const wrap = h.parentElement;
			if (wrap?.tagName === "DIV" && wrap.querySelectorAll("h1, h2, h3, h4, h5, h6").length === 1 && wrap.textContent.trim().length - h.textContent.trim().length < 40) wrap.replaceWith(h);
		}
		const article = new Readability(doc, { keepClasses: true }).parse();
		if (article?.content) {
			html = article.content;
			title = article.title || title;
		}
	} catch {
		/* fall back to the whole body */
	}
	if (!html) html = document.body?.innerHTML ?? "";
	// "Post Title | Site" → "Post Title" when the page's own heading says so.
	const h1 = document.querySelector("h1")?.textContent?.trim();
	if (h1 && title.startsWith(h1) && title.length > h1.length) title = h1;
	return { url, title, html };
}

async function capture(tabId) {
	// MAIN world: only the page's own world sees web components' shadow
	// roots (MDN's code examples). Nothing extension-side is exposed there.
	await chrome.scripting.executeScript({ target: { tabId }, files: ["vendor/Readability.js"], world: "MAIN" });
	const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: capturePage, world: "MAIN" });
	if (!result?.result) throw new Error("Could not read this page.");
	return result.result;
}

async function rpc(server, token, method, params) {
	let res;
	try {
		res = await fetch(`${server}/api/mcp`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
		});
	} catch {
		throw new Error(`Socratech is not running at ${server}. Start it, or press Connect Claude in its Settings → Claude.`);
	}
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

	// Only the server Connect Claude saved — never another localhost app.
	if (!isLoopback(server)) throw new Error("The saved server is not on this computer. Press Connect Claude in Socratech.");
	const result = await callTool(server, token, args);
	await chrome.tabs.create({ url: `${server}${result.path}` });
	return { ok: true, ...result };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
	if (msg?.type === "connect") {
		// Only from our content script, and only for the page it runs in.
		if (sender.id !== chrome.runtime.id || !sender.url || new URL(sender.url).origin !== msg.server) return;
		connect(msg.server, String(msg.token)).then(reply, (err) => reply({ ok: false, error: String(err.message ?? err) }));
		return true;
	}
	if (msg?.type !== "clip") return;
	clip(msg.tabId).then(reply, (err) => reply({ ok: false, error: String(err?.message ?? err) }));
	return true; // async reply
});
