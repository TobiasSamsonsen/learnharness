/**
 * POST { feedback? } — draft the course's skill map from its curriculum,
 * or re-draft the pending draft with the owner's change request (fork
 * addition — docs/courses.md §3). Returns at once; the planner runs in the
 * background and announces courses-changed when the draft lands.
 */
import { startCourseDraft } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => ({}))) as { feedback?: unknown };
	const result = startCourseDraft(id, typeof body.feedback === "string" ? body.feedback : undefined);
	return result.ok
		? Response.json({ course: result.value }, { status: 202 })
		: Response.json({ error: result.error }, { status: result.status });
}
