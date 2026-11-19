/** What the tutor has of a lecture note (fork addition, 2026-11-19): each segment's text, its state, the lecture's one line. */
import { lectureNoteTranscript } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; noteId: string }> }) {
	const { id, noteId } = await params;
	const view = lectureNoteTranscript(id, noteId);
	return view ? Response.json(view) : Response.json({ error: "Unknown note" }, { status: 404 });
}
