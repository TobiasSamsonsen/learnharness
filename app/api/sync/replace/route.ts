/**
 * Replace this device's synced data with the repo's (fork addition,
 * 2026-11-03) — the "Replace this device with the repo" button. Nothing is
 * pushed. What is replaced or removed is first copied to
 * data/sync/replaced-<time>/ (see src/server/sync/engine.ts runReplace).
 *
 *   POST { dryRun: true }    → { preview, error }: counts by folder of what would
 *                              be added/overwritten and removed. Changes nothing.
 *   POST { confirm: true }   → SyncStatus once it has finished (a failed or refused
 *                              replace is a 200 with `error` set).
 *   anything else            → 400: it never runs without an explicit confirm.
 */
import { previewReplaceFromRepo, replaceDeviceFromRepo } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { dryRun?: unknown; confirm?: unknown } | null;
	if (body?.dryRun === true) return Response.json(await previewReplaceFromRepo());
	if (body?.confirm !== true) {
		return Response.json({ error: "Body must be {dryRun: true} or {confirm: true}" }, { status: 400 });
	}
	return Response.json(await replaceDeviceFromRepo());
}
