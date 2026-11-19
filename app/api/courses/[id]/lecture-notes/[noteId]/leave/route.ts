/** The learner left a lecture note (fork addition, 2026-11-19): the course page refetches its row. */
import { leaveLectureNote } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string; noteId: string }> }) {
	const { id, noteId } = await params;
	return leaveLectureNote(id, noteId) ? Response.json({ ok: true }) : Response.json({ error: "Unknown note" }, { status: 404 });
}
