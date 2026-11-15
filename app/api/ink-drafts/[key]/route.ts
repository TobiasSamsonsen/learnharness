/** The server copy of one page's UNSENT ink (owner plan, 2026-11-15): GET it after a reload that lost the browser's copy,
 *  PUT it after a pause in drawing, DELETE it once the page is sent. The body is the strokes JSON the client keeps locally. */
import { deleteInkDraft, INK_DRAFT_MAX_BYTES, readInkDraft, saveInkDraft } from "@/src/server";
import { parseSketchPayload, newSketchId } from "@/src/core";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };
const KEY = /^[A-Za-z0-9_-]{1,128}$/;

export async function GET(_req: Request, { params }: Ctx) {
	const { key } = await params;
	if (!KEY.test(key)) return Response.json({ error: "Invalid key" }, { status: 400 });
	const body = readInkDraft(key);
	if (body === null) return Response.json({ error: "No draft" }, { status: 404 });
	return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export async function PUT(req: Request, { params }: Ctx) {
	const { key } = await params;
	if (!KEY.test(key)) return Response.json({ error: "Invalid key" }, { status: 400 });
	const text = await req.text();
	if (text.length > INK_DRAFT_MAX_BYTES) return Response.json({ error: "Draft too large" }, { status: 413 });
	try {
		// the same validation a submit gets: a damaged draft is refused, never stored
		parseSketchPayload({ id: newSketchId(), producer: "web-canvas", strokes: JSON.parse(text) });
		saveInkDraft(key, text);
	} catch {
		return Response.json({ error: "Invalid draft" }, { status: 400 });
	}
	return new Response(null, { status: 204 });
}

export async function DELETE(_req: Request, { params }: Ctx) {
	const { key } = await params;
	if (!KEY.test(key)) return Response.json({ error: "Invalid key" }, { status: 400 });
	deleteInkDraft(key);
	return new Response(null, { status: 204 });
}
