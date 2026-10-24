/**
 * The upstream release notice (fork addition, 2026-10-24) — see
 * src/server/upstream.ts.
 *
 *   GET ?refresh=1 → UpstreamStatus (cached ~6h; refresh forces a check).
 *   PUT { dismissedUpstreamVersion } → hide the notice for that release;
 *       a newer upstream release shows it again.
 */
import { dismissUpstreamVersion, upstreamStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	const refresh = new URL(req.url).searchParams.get("refresh") === "1";
	return Response.json(await upstreamStatus({ refresh }));
}

export async function PUT(req: Request) {
	const body = (await req.json().catch(() => null)) as { dismissedUpstreamVersion?: unknown } | null;
	if (typeof body?.dismissedUpstreamVersion !== "string" || !body.dismissedUpstreamVersion) {
		return Response.json({ error: "Body must be {dismissedUpstreamVersion: string}" }, { status: 400 });
	}
	dismissUpstreamVersion(body.dismissedUpstreamVersion);
	return Response.json(await upstreamStatus());
}
