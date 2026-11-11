import { learnerStats } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/learner — the automatic layer of the learner profile for the
 * Settings page (fork addition, 2026-11-11): the mistake fold and the
 * calibration counts, with the floors' verdicts, folded from the chats on the
 * spot. Nothing is stored.
 */
export async function GET() {
	return Response.json(learnerStats());
}
