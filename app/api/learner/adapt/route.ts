import { runAdapt } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/learner/adapt — the on-demand Adapt pass (fork addition,
 * 2026-11-11): digests the chats and drafts claims about the learner. The draft
 * is returned to the page and never stored; the learner edits it and Applies
 * it through PUT /api/settings/learner. 409 below three sessions of evidence,
 * 503 with no model configured, 502 when the model fails.
 */
export async function POST(request: Request) {
	const outcome = await runAdapt(request.signal);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json(outcome.draft);
}
