/**
 * /api/chats/[id]/hint — one hint on the pending lesson question (src/server/hint.ts).
 *   POST {toolCallId, earlier: string[], thinking?} → {hint, n}: one text-only call on the chat's own model; nothing
 *        enters the transcript. 400 no hints on this question or three already taken · 409 the question is no longer
 *        open, or the tutor is writing · 502 the call failed.
 */
import { handleHintRequest } from "@/src/server";

export const maxDuration = 130;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	return handleHintRequest(id, body);
}
