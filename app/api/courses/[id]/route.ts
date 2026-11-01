/**
 * One course (fork addition — docs/courses.md §5).
 *
 *   GET    → CourseView + { drafting } — the record, every skill's box and
 *            state, the route (review / next up / locked / known), sessions
 *   PATCH  { title? , note? } → rename, and/or set the time note ("exam
 *            Thursday, 4 concepts"; blank clears it)
 *   DELETE → the record and its material; its skills stay in the graph
 */
import { courseDrafting, courseView, deleteCourse, parsePaceNoteField, renameCourse, setCourseNote } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const view = courseView(id);
	if (!view) return Response.json({ error: "Unknown course" }, { status: 404 });
	return Response.json({ ...view, drafting: courseDrafting(id) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { title?: unknown; note?: unknown } | null;
	const hasNote = body?.note !== undefined;
	// A body with neither field keeps the original rejection (a rename needs a title).
	if (body?.title !== undefined || !hasNote) {
		if (typeof body?.title !== "string" || body.title.trim() === "") {
			return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
		}
	}
	let note: string | undefined;
	if (hasNote) {
		const parsed = parsePaceNoteField(body?.note);
		if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
		note = parsed.note;
	}
	let course = null;
	if (typeof body?.title === "string") course = renameCourse(id, body.title);
	if (hasNote && (typeof body?.title !== "string" || course)) course = setCourseNote(id, note);
	return course
		? Response.json({ title: course.title, ...(course.note ? { note: course.note } : {}) })
		: Response.json({ error: "Unknown course" }, { status: 404 });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return deleteCourse(id) ? Response.json({ ok: true }) : Response.json({ error: "Unknown course" }, { status: 404 });
}
