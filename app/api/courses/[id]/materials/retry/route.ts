/** Retry reading failed curriculum materials for a course (all failed, or one by `materialId`). */
import { listMaterials, retryFailedMaterials, retryMaterial, stores } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!stores.courseStore.getCourse(id)) return Response.json({ error: "Unknown course" }, { status: 404 });
	const body = (await req.json().catch(() => ({}))) as { materialId?: unknown } | null;
	if (body?.materialId !== undefined) {
		if (typeof body.materialId !== "string" || body.materialId.trim().length === 0) {
			return Response.json({ error: "materialId must be a non-empty string" }, { status: 400 });
		}
		const result = retryMaterial(id, body.materialId.trim());
		return result.ok
			? Response.json({ materials: listMaterials(id), retried: 1 })
			: Response.json({ error: result.error }, { status: result.status });
	}
	const result = retryFailedMaterials(id);
	return result.ok
		? Response.json({ materials: listMaterials(id), retried: result.value.length })
		: Response.json({ error: result.error }, { status: result.status });
}
