/**
 * POST /api/stt/local/prepare — { language } → 202: download (first time)
 * and load that language's local dictation model in the background. The
 * settings page's Download button and the dictation start path call it,
 * so recording overlaps the model load; GET /api/stt/local reports the
 * progress.
 */
import { isLessonLanguage } from "@/src/core";
import { prepareLocalStt } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { language?: unknown } | null;
	if (!isLessonLanguage(body?.language)) {
		return Response.json({ error: "Body must be {language: \"en\" | \"nb\"}" }, { status: 400 });
	}
	void prepareLocalStt(body.language).catch(() => {}); // failures land in the status
	return Response.json({ started: true }, { status: 202 });
}
