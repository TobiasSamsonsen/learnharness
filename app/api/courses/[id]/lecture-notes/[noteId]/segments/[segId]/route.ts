/** Save one segment of a lecture's ink (fork addition, 2026-11-19). Body: { startedAt, endedAt, strokes }; empty strokes remove it. */
import { saveLectureNoteSegment } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string; noteId: string; segId: string }> }) {
	const { id, noteId, segId } = await params;
	const result = saveLectureNoteSegment(id, noteId, segId, await req.text());
	return result.ok ? new Response(null, { status: 204 }) : Response.json({ error: result.error }, { status: result.status });
}
