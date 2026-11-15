import { isLoopback, loadSettings, saveSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);
const status = (text, err = false) => {
	$("status").textContent = text;
	$("status").className = err ? "err" : "";
};

const current = await loadSettings();
$("server").value = current.server;
$("token").value = current.token;

$("paste").addEventListener("input", () => {
	try {
		const { server, token } = JSON.parse($("paste").value);
		if (typeof server === "string") $("server").value = server;
		if (typeof token === "string") $("token").value = token;
		status("Setup read — press Save.");
	} catch {
		/* still typing */
	}
});

$("save").addEventListener("click", async () => {
	const server = $("server").value.trim();
	const token = $("token").value.trim();
	if (!isLoopback(server)) return status("Server must be http://localhost or http://127.0.0.1 — Socratech answers only on this machine.", true);
	if (token.length < 64) return status("That token looks incomplete — copy the setup again.", true);
	await saveSettings({ server, token });
	status("Saved.");
});
