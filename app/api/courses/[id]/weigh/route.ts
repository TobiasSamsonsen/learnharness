/**
 * "Weigh by exams" (src/server/courses.ts startCourseWeighing, owner 2026-11-13).
 *
 *   POST → starts the pass in the background and answers { weighing: true } at once; the weights, the summary or the
 *          failure land on the course record and announce courses-changed.
 *   400 no approved skills or no curriculum · 404 unknown course · 409 already running
 */
import { startCourseWeighing } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const started = startCourseWeighing(id);
	if (!started.ok) return Response.json({ error: started.error }, { status: started.status });
	return Response.json({ weighing: true });
}
