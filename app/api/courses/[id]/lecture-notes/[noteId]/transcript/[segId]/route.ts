/** The learner's correction of one segment's text. Body: { text }. It is kept: an automatic reading never overwrites it. */
import { editLectureNoteSegment } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string; noteId: string; segId: string }> }) {
	const { id, noteId, segId } = await params;
	const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
	if (typeof body?.text !== "string") return Response.json({ error: "text must be a string" }, { status: 400 });
	return editLectureNoteSegment(id, noteId, segId, body.text) ? new Response(null, { status: 204 }) : Response.json({ error: "Unknown segment" }, { status: 404 });
}
