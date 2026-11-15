// Settings → Claude → Connect Claude posts the token to its own window; this
// relays it to the service worker, which checks it against this page's own
// origin before saving (a page can't point the extension anywhere else).
window.addEventListener("message", (event) => {
	if (event.source !== window || event.origin !== location.origin) return;
	const data = event.data;
	if (!data || data.type !== "socratech-clip-setup" || typeof data.token !== "string") return;
	chrome.runtime.sendMessage({ type: "connect", server: location.origin, token: data.token }, (reply) => {
		window.postMessage(
			{ type: "socratech-clip-connected", nonce: data.nonce, ok: reply?.ok === true, error: reply?.error },
			location.origin,
		);
	});
});
