/**
 * POST — approve the pending draft: its skills are written to the graph's
 * skill ledger (reused skills link-append) and become the course's skill
 * set (fork addition — docs/courses.md §1.2).
 */
import { approveCourse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const result = approveCourse(id);
	return result.ok ? Response.json({ course: result.value }) : Response.json({ error: result.error }, { status: result.status });
}
