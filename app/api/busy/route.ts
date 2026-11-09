/**
 * Is the server busy? (fork addition, 2026-11-03.) The Android app polls this to rest an unused server: the wake lock goes after
 * 10 idle minutes, the server stops after 30. See src/server/busy.ts for what counts as work.
 *
 *   GET → { busy: boolean, reasons: string[] }
 *
 * Behind the same token gate as every other /api route; the app sends its pairing cookie.
 */
import { serverBusy } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(serverBusy());
}
