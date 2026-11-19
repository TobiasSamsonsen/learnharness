/** A course's lecture notes (fork addition, 2026-11-19): list, and create one (title and date, both optional). */
import { createLectureNote, listLectureNotes } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const notes = listLectureNotes(id);
	return notes ? Response.json({ notes }) : Response.json({ error: "Unknown course" }, { status: 404 });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; date?: unknown };
	const note = createLectureNote(id, body ?? {});
	return note ? Response.json({ note }, { status: 201 }) : Response.json({ error: "Unknown course" }, { status: 404 });
}
