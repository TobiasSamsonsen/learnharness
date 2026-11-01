/**
 * POST /api/chats/[id]/clarify — {key, quote, question}: the learner marked a
 * passage of the learning text and asks about it while the quiz question `key`
 * is pending. One text-only call on the chat's own model answers; the reply is
 * stored in the record's clarification thread (src/server/clarify.ts).
 */
import { handleClarifyRead, handleClarifyRequest } from "@/src/server";

export const maxDuration = 130;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	return handleClarifyRead(id, new URL(req.url).searchParams.get("key") ?? "");
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
