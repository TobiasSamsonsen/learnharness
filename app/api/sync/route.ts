/**
 * GitHub sync status (fork addition, 2026-11-02) — see src/server/sync-service.ts.
 *
 *   GET → SyncStatus: whether a repo and a token are set (never the token),
 *         whether a round is running, when the last one finished, its outcome
 *         and any error, files held back, and the conflict copies kept.
 */
import { syncStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(syncStatus());
}
