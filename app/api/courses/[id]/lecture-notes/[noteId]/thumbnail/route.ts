/** The overview picture of a lecture note's ink (fork addition, 2026-11-19), rendered once per change of the ink. */
import { lectureNoteThumbnail } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; noteId: string }> }) {
	const { id, noteId } = await params;
	const png = await lectureNoteThumbnail(id, noteId);
	if (!png) return Response.json({ error: "No ink" }, { status: 404 });
	return new Response(png as unknown as BodyInit, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=31536000, immutable" } });
}
