/** GET one page of a learner's sketch (fork addition, 2026-10-26):
 *  ?format=svg (the default — the UI's thumbnails) or ?format=png (what
 *  the model saw). Pages never change once stored, so they cache. */
import { readSketchPage, sniffImageMime } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; sketchId: string; page: string }> }) {
	const { id, sketchId, page } = await params;
	const format = new URL(req.url).searchParams.get("format") === "png" ? "png" : "svg";
	const index = /^\d{1,2}$/.test(page) ? Number(page) : -1;
	const body = index < 0 ? null : readSketchPage(id, sketchId, index, format);
	if (body === null) return Response.json({ error: "Unknown sketch page" }, { status: 404 });
	return new Response(body as BodyInit, {
		headers: {
			"Content-Type": format === "png" ? sniffImageMime(body as Uint8Array) : "image/svg+xml",
			"Cache-Control": "private, max-age=31536000, immutable",
		},
	});
}
