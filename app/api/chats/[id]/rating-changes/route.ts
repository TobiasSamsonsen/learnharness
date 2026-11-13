/**
 * What each concluded problem of a course practice session did to its skills (src/server/courses.ts ratingChanges,
 * owner 2026-11-13).
 *
 *   GET → { changes: [{ callId, skills: [{ id, name, before, after, reviewAt }] }] }: understanding (0-10) before and
 *         after each problem, and when recall reaches the review target. 404 when the chat is not a course practice,
 *         review or check session.
 */
import { ratingChanges } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const changes = ratingChanges(id);
	if (!changes) return Response.json({ error: "Not a course practice session" }, { status: 404 });
	return Response.json({ changes });
}
