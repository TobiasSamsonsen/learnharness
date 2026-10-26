/**
 * Local dictation (fork addition, 2026-10-24) — on-device Whisper, see
 * src/server/stt-local.ts.
 *
 *   GET  → { models: LocalSttStatus[] } — every language's model state
 *          (absent / downloading + progress / loading / cached / ready / error).
 *   POST ?language=en|nb, body = the whole utterance as 16 kHz mono Int16
 *          little-endian PCM (application/octet-stream) → { text }.
 *          The first call for a language downloads its model (hundreds of
 *          MB) before transcribing; GET reports the progress meanwhile.
 *          Optional &chat=<id>: the whisper.cpp engine (LH_STT_ENGINE) biases
 *          the transcript toward that lesson's terms (Android plan M4).
 *
 * Audio never leaves the machine: the model runs in a local worker.
 */
import { isLessonLanguage } from "@/src/core";
import { localSttStatuses, transcribeLocal, vocabularyForChat } from "@/src/server";

export const dynamic = "force-dynamic";

/** 10 minutes of 16 kHz Int16 audio — far past any dictation run. */
const MAX_BYTES = 10 * 60 * 16_000 * 2;

export async function GET() {
	return Response.json({ models: localSttStatuses() });
}

export async function POST(req: Request) {
	const language = new URL(req.url).searchParams.get("language");
	if (!isLessonLanguage(language)) {
		return Response.json({ error: "language must be en or nb" }, { status: 400 });
	}
	const pcm = new Uint8Array(await req.arrayBuffer());
	if (pcm.byteLength > MAX_BYTES) {
		return Response.json({ error: "recording too long (max 10 minutes)" }, { status: 413 });
	}
	const vocabulary = vocabularyForChat(new URL(req.url).searchParams.get("chat"), language);
	const reply = await transcribeLocal(language, pcm, vocabulary || undefined);
	if (!reply.ok) return Response.json({ error: reply.error }, { status: 500 });
	return Response.json({ text: reply.text ?? "" });
}
