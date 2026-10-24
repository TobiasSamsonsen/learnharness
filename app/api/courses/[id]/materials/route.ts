/**
 * A course's curriculum (fork addition — docs/courses.md §1.2): the same
 * contract as a lesson's source material (app/api/chats/[id]/materials).
 *
 *   GET  → { materials: LessonMaterial[] }
 *   POST multipart "file" fields, or JSON { url } → { materials: [...added] }
 */
import { addLinkMaterial, addUploadedMaterial, listMaterials, stores } from "@/src/server";
import type { LessonMaterial } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!stores.courseStore.getCourse(id)) return Response.json({ error: "Unknown course" }, { status: 404 });
	return Response.json({ materials: listMaterials(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!stores.courseStore.getCourse(id)) return Response.json({ error: "Unknown course" }, { status: 404 });
	const type = req.headers.get("content-type") ?? "";
	if (type.startsWith("application/json")) {
		const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
		if (typeof body?.url !== "string") return Response.json({ error: "Body must be {url: string}" }, { status: 400 });
		const result = await addLinkMaterial(id, body.url);
		return result.ok
			? Response.json({ materials: [result.value] }, { status: 201 })
			: Response.json({ error: result.error }, { status: result.status });
	}
	const form = await req.formData().catch(() => null);
	const files = (form?.getAll("file") ?? []).filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
	if (files.length === 0) return Response.json({ error: 'Send the files as multipart "file" fields, or JSON {url}' }, { status: 400 });
	const added: LessonMaterial[] = [];
	for (const file of files) {
		const result = addUploadedMaterial(id, { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
		if (!result.ok) return Response.json({ error: result.error, materials: added }, { status: result.status });
		added.push(result.value);
	}
	return Response.json({ materials: added }, { status: 201 });
}
