/**
 * Runs once when the server starts (Next's instrumentation hook; the Electron
 * app and the Android guest start the same standalone server, so it runs
 * there too).
 *
 * - The GitHub sync loop (fork addition, 2026-11-02): pull now, then every few
 *   minutes, and push shortly after the data stops changing. Nothing happens
 *   until a repo and a token are set in Settings. It starts FIRST: plugin
 *   initialization may take a while, and sync must not wait for it.
 * - Plugins use the documented per-server initialization hook. A plugin failure
 *   must not prevent access to existing learning data or teaching/practice.
 */
export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { startSyncLoop } = await import("./src/server/sync-service.ts");
	startSyncLoop();
	const { initializePlugins } = await import("./src/server/plugins.ts");
	try { await initializePlugins(); }
	catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
}
