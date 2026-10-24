/**
 * POST /api/upstream/claude (fork addition) — open a terminal running
 * Claude Code in the fork's checkout, asked to merge the latest upstream
 * release. 200 {ok: true} once the terminal is launched; 409 with the
 * reason when it can't be (no update, unknown folder, no claude CLI).
 */
import { launchClaudeUpdate } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	const result = await launchClaudeUpdate();
	return Response.json(result, { status: result.ok ? 200 : 409 });
}
