/**
 * One course (fork addition — docs/courses.md §5).
 *
 *   GET    → CourseView + { drafting } — the record, every skill's box and
 *            state, the route (review / next up / locked / known), sessions
 *   PATCH  { title } → rename
 *   DELETE → the record and its material; its skills stay in the graph
 */
import { courseDrafting, courseView, deleteCourse, renameCourse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const view = courseView(id);
	if (!view) return Response.json({ error: "Unknown course" }, { status: 404 });
	return Response.json({ ...view, drafting: courseDrafting(id) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
	if (typeof body?.title !== "string" || body.title.trim() === "") {
		return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
	}
	const course = renameCourse(id, body.title);
	return course ? Response.json({ title: course.title }) : Response.json({ error: "Unknown course" }, { status: 404 });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return deleteCourse(id) ? Response.json({ ok: true }) : Response.json({ error: "Unknown course" }, { status: 404 });
}
