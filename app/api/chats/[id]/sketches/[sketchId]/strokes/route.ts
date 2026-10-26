/** GET a stored sketch's strokes (Android plan M3): the kept page's
 *  submitted ink, restored after a reload. */
import { readSketchStrokes } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; sketchId: string }> }) {
	const { id, sketchId } = await params;
	const body = readSketchStrokes(id, sketchId);
	if (body === null) return Response.json({ error: "Unknown sketch" }, { status: 404 });
	return new Response(body, {
		headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=31536000, immutable" },
	});
}
