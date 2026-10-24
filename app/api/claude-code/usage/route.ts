/** GET /api/claude-code/usage (fork addition) — the Claude plan's usage as
 *  Claude Code last reported it: { usage: { fiveHour?, sevenDay?, at } | null }.
 *  Updated by every Claude Code call; null until the first one. */
import { claudePlanUsage } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ usage: claudePlanUsage() });
}
