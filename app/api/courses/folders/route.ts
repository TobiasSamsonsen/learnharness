/**
 * Course folders (src/server/courses.ts changeCourseFolders, owner 2026-11-14): a folder is a name on each course, so
 * these two actions rewrite that name on every course in the folder.
 *
 *   POST { action: "rename", from, to } → { changed }: every course in `from` moves to `to`, merging into a folder of
 *        that name that already exists
 *   POST { action: "remove", name }     → { changed }: its courses leave the folder; no course is deleted
 *   400 on a bad body or a name that is not 1 to 60 characters.
 */
import { changeCourseFolders } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { action?: unknown; from?: unknown; to?: unknown; name?: unknown } | null;
	let result;
	if (body?.action === "rename" && typeof body.from === "string" && typeof body.to === "string") {
		result = changeCourseFolders({ action: "rename", from: body.from, to: body.to });
	} else if (body?.action === "remove" && typeof body.name === "string") {
		result = changeCourseFolders({ action: "remove", name: body.name });
	} else {
		return Response.json({ error: 'Body must be {action:"rename",from,to} or {action:"remove",name}' }, { status: 400 });
	}
	return result.ok ? Response.json(result.value) : Response.json({ error: result.error }, { status: result.status });
}
