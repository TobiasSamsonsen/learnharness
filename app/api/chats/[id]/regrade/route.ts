/**
 * "Grade again" on a concluded practice problem that no model graded
 * (src/server/practice-grade.ts regradeConcludedProblem).
 *
 *   POST { toolCallId } → { ok: true }
 *   400 bad body or no tagged skills · 404 unknown session/problem or not a course practice session ·
 *   409 a turn is running or the problem is already graded · 502 the grading failed again ({ error } says why).
 */
import { regradeConcludedProblem } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { toolCallId?: unknown } | null;
	if (!body || typeof body.toolCallId !== "string" || body.toolCallId === "") {
		return Response.json({ error: "toolCallId is required" }, { status: 400 });
	}
	const result = await regradeConcludedProblem(id, body.toolCallId);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ ok: true });
}
