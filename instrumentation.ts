/** Plugins use the documented per-server initialization hook. A plugin failure
 * must not prevent access to existing learning data or teaching/practice. */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { initializePlugins } = await import("./src/server/plugins.ts");
		try { await initializePlugins(); }
		catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
		// RunPod pods a crash or quit left running bill until terminated — do it at boot.
		void import("./src/server/accelerators.ts").then((m) => m.reconcileRunPods()).catch((error) => console.error("[accelerators] pod reconcile failed:", error));
	}
}
