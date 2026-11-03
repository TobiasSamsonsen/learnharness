/**
 * Run a GitHub sync round now (fork addition, 2026-11-02): the Sync button.
 * Joins a round already running. Answers with the status once it finishes; a
 * failed round is a 200 with `error` set, not an HTTP error (the request
 * itself worked).
 */
import { runSyncNow } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	return Response.json(await runSyncNow());
}
