/** One lecture note (fork addition, 2026-11-19): read it with its ink, rename or redate it, delete it. */
import { deleteLectureNote, readLectureNote, updateLectureNote } from "@/src/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; noteId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
	const { id, noteId } = await params;
	const read = readLectureNote(id, noteId);
	return read ? Response.json(read) : Response.json({ error: "Unknown note" }, { status: 404 });
}

export async function PATCH(req: Request, { params }: Ctx) {
	const { id, noteId } = await params;
	const body = (await req.json().catch(() => null)) as { title?: unknown; date?: unknown } | null;
	if (!body || (body.title === undefined && body.date === undefined)) return Response.json({ error: "Nothing to change" }, { status: 400 });
	const note = updateLectureNote(id, noteId, body);
	return note ? Response.json({ note }) : Response.json({ error: "Unknown note, or an empty title or an invalid date" }, { status: 404 });
}

export async function DELETE(_req: Request, { params }: Ctx) {
	const { id, noteId } = await params;
	return deleteLectureNote(id, noteId) ? Response.json({ ok: true }) : Response.json({ error: "Unknown note" }, { status: 404 });
}
