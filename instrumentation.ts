/**
 * Runs once when the server starts (Next's instrumentation hook; the Electron
 * app and the Android guest start the same standalone server, so it runs
 * there too). It starts the GitHub sync loop (fork addition, 2026-11-02):
 * pull now, then every few minutes, and push shortly after the data stops
 * changing. Nothing happens until a repo and a token are set in Settings.
 */
export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { startSyncLoop } = await import("./src/server/sync-service.ts");
	startSyncLoop();
}
