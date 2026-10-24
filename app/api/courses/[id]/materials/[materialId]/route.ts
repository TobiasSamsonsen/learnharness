/** DELETE one piece of a course's curriculum (fork addition): its record,
 *  stored copy and any read in progress. */
import { removeMaterial, stores } from "@/src/server";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; materialId: string }> }) {
	const { id, materialId } = await params;
	if (!stores.courseStore.getCourse(id)) return Response.json({ error: "Unknown course" }, { status: 404 });
	return removeMaterial(id, materialId)
		? Response.json({ ok: true })
		: Response.json({ error: "Unknown material" }, { status: 404 });
}
