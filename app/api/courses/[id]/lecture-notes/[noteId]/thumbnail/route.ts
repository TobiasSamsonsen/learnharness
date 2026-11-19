/** The overview picture of a lecture note's ink (fork addition, 2026-11-19), rendered once per change of the ink. Revalidated by ETag (the picture of a note can change back to an older state, so it is never cached as final). */
import { lectureNoteThumbnail } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; noteId: string }> }) {
	const { id, noteId } = await params;
	const thumb = await lectureNoteThumbnail(id, noteId);
	if (!thumb) return Response.json({ error: "No ink" }, { status: 404 });
	const headers = { "Cache-Control": "private, no-cache", ETag: thumb.etag };
	if (req.headers.get("if-none-match") === thumb.etag) return new Response(null, { status: 304, headers });
	return new Response(thumb.png as unknown as BodyInit, { headers: { ...headers, "Content-Type": "image/png" } });
}
