/**
 * Courses (fork addition — docs/courses.md §5).
 *
 *   GET  → { courses: CourseSummary[] } — the sidebar's rows (% known, due)
 *   POST { title? } → { id, title } — a new course ("Untitled course")
 */
import { createCourse, listCourseSummaries } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ courses: listCourseSummaries() });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown };
	const course = createCourse(typeof body.title === "string" ? body.title : "");
	return Response.json({ id: course.id, title: course.title }, { status: 201 });
}
