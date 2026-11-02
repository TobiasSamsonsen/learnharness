/**
 * /api/chats/[id]/clarify — the margin threads of a session (src/server/clarify.ts).
 *   GET   → {threads}: every thread of the chat.
 *   POST  {question, threadId} (a follow-up) or {question, anchor, quote} (a new thread) → {thread}: one text-only call on
 *         the chat's own model answers; the pair is stored in the record's clarifyThreads.
 */
import { handleClarifyRead, handleClarifyRequest } from "@/src/server";

export const maxDuration = 130;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	return handleClarifyRead(id);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	return handleClarifyRequest(id, body);
}
