/**
 * POST { mode, skillId? } → { id, title, prompt } — start a session from
 * the course (fork addition — docs/courses.md §4). learn needs a skill;
 * practice takes one skill or, without one, everything next up; review
 * and placement take the course's due / all skills. The client opens
 * /chat/<id>?prompt=<prompt>.
 */
import { createCourseSession } from "@/src/server";
import { COURSE_MODES, type CourseMode } from "@/src/core";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { mode?: unknown; skillId?: unknown } | null;
	const mode = body?.mode as CourseMode;
	if (!COURSE_MODES.includes(mode)) {
		return Response.json({ error: `mode must be one of ${COURSE_MODES.join(", ")}` }, { status: 400 });
	}
	const skillId = typeof body?.skillId === "string" ? body.skillId : undefined;
	const result = createCourseSession(id, mode, skillId);
	return result.ok ? Response.json(result.value, { status: 201 }) : Response.json({ error: result.error }, { status: result.status });
}
