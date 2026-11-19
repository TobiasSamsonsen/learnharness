/** Read a lecture note's ink to text again (fork addition, 2026-11-19). Body: { segments?: string[] } (default: all). Runs in the background. */
import { rereadLectureNote } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; noteId: string }> }) {
	const { id, noteId } = await params;
	const body = (await req.json().catch(() => ({}))) as { segments?: unknown } | null;
	const segs = Array.isArray(body?.segments) ? (body.segments as unknown[]).filter((s): s is string => typeof s === "string") : null;
	return rereadLectureNote(id, noteId, segs) ? Response.json({ ok: true }, { status: 202 }) : Response.json({ error: "Unknown note" }, { status: 404 });
}
