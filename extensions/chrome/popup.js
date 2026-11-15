const button = document.getElementById("clip");
const status = document.getElementById("status");
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
document.getElementById("title").textContent = tab?.title ?? "";
document.getElementById("options").addEventListener("click", (e) => {
	e.preventDefault();
	chrome.runtime.openOptionsPage();
});

button.addEventListener("click", async () => {
	button.disabled = true;
	status.className = "";
	status.textContent = "Reading the page…";
	const result = await chrome.runtime.sendMessage({ type: "clip", tabId: tab.id });
	if (result?.ok) {
		status.textContent = `Added “${result.title}” (${result.cells} cells).\n${result.message ?? ""}`;
	} else {
		status.className = "err";
		status.textContent = result?.error ?? "Failed.";
		button.disabled = false;
	}
});
