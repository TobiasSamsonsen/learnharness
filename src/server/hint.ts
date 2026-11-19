import { HINT_MAX, HINT_THINKING_MAX, type HintSize, hintEligible, hintPrompt, hintsOf, parseHintReply, practiceHintEligible, practiceHintPrompt, practiceHintsOf, stripHintLabel } from "../core/hints.ts";
import { activeProblemOf, hasProbeDone, newPracticeHintMarker } from "../core/native-messages.ts";
import { emit } from "../core/events.ts";
import { hintPageName, parseSketchPayload, SketchPayloadError } from "../core/sketch.ts";
import type { PiEngine } from "../agent/models.ts";
import { tutorSideCall } from "./clarify.ts";
import { renderSketchImages } from "./sketches.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/**
 * POST /api/chats/[id]/hint — body {toolCallId, earlier?: string[], thinking?, sketch?}: one hint on the pending lesson
 * question (owner, 2026-11-13 — core/hints.ts) or on the open practice problem (owner, 2026-11-17). ONE call on the chat's
 * own model with the session so far, the clarification call's twin (tutorSideCall): the question stays open.
 *
 * `sketch` (2026-11-17) is the learner's CURRENT page, kept plus unsent strokes: it is rendered here and rides
 * the call as an image, so the hint fits where they are stuck. Without it (no ink) the hint is text-only.
 *
 * A LESSON hint lives with the dock and rides the learner's answer; the route only writes the call's usage and answers
 * {hint, n}. A PRACTICE hint is written into the chat as a `practice-hint` marker with the size the model chose (slip, nudge,
 * carry): the record, not the browser, holds the count (cap 3), and the grader and the conclude rule read the sizes there.
 * It answers {hint, n, size, hints} with every hint on the problem.
 */
export async function handleHintRequest(chatId: string, body: unknown, engineOverride?: PiEngine): Promise<Response> {
	const raw = (body ?? {}) as { toolCallId?: unknown; earlier?: unknown; thinking?: unknown; sketch?: unknown };
	if (typeof raw.toolCallId !== "string" || !raw.toolCallId) return Response.json({ error: "toolCallId is required" }, { status: 400 });
	const toolCallId = raw.toolCallId;
	const earlier = hintsOf(raw.earlier);
	if (Array.isArray(raw.earlier) && raw.earlier.length >= HINT_MAX) return Response.json({ error: `A question has at most ${HINT_MAX} hints` }, { status: 400 });
	const thinking = typeof raw.thinking === "string" ? raw.thinking.slice(0, HINT_THINKING_MAX) : undefined;
	if (!stores.chatStore.getChat(chatId)) return Response.json({ error: "Unknown chat" }, { status: 404 });

	// The learner's current page, rendered without being stored (a bad or empty payload is no ink, not an error: the hint goes text-only).
	let images: { data: string; mimeType: string }[] = [];
	let strokeCount = 0;
	if (raw.sketch !== undefined && raw.sketch !== null) {
		try {
			const sketch = parseSketchPayload(raw.sketch);
			strokeCount = sketch.strokes.length;
			if (sketch.strokes.length > 0 || sketch.photo) images = await renderSketchImages(sketch);
		} catch (error) {
			if (!(error instanceof SketchPayloadError)) {
				console.error(`[chat ${chatId}] hint: the sketch could not be rendered:`, error);
			}
			images = [];
		}
	}
	const ink = images.length > 0;

	let n = earlier.length + 1;
	/** Set when the hint is for the open practice problem: the earlier button hints come from the record, not the client. */
	const practice: { earlier: { size: HintSize; text: string }[] | null } = { earlier: null };
	const result = await tutorSideCall(
		chatId,
		({ record, pending }) => {
			// Read after the awaits: the learner may have answered meanwhile.
			if (pending && pending.toolCallId === toolCallId) {
				const phase = hasProbeDone(record.messages) ? "teach" : "probe";
				if (!hintEligible(pending.tool, pending.input, phase)) return Response.json({ error: "This question has no hints" }, { status: 400 });
				return hintPrompt({ n, earlier, ...(thinking ? { thinking } : {}), ...(ink ? { ink } : {}) });
			}
			const active = activeProblemOf(record.messages);
			if (!active || active.toolCallId !== toolCallId) return Response.json({ error: "That question is no longer open" }, { status: 409 });
			if (!practiceHintEligible(active.input)) return Response.json({ error: "This problem has no hints" }, { status: 400 });
			const taken = practiceHintsOf(record.messages, toolCallId);
			practice.earlier = taken;
			if (taken.length >= HINT_MAX) return Response.json({ error: `A problem has at most ${HINT_MAX} hints` }, { status: 400 });
			n = taken.length + 1;
			return practiceHintPrompt({ n, earlier: taken, ...(thinking ? { thinking } : {}), ...(ink ? { ink } : {}) });
		},
		{
			usageId: `hint_${crypto.randomUUID()}`,
			label: "hint",
			failure: "The tutor could not give a hint just now. Try again.",
			empty: "The tutor sent an empty hint. Try again.",
			...(ink ? { images } : {}),
		},
		engineOverride,
	);
	if (result instanceof Response) return result;
	// What the hint was written from, kept beside the chat's sketches (2026-11-18): a hint that misses the learner's work can then be
	// checked against the page the model saw. Best effort: a failed write never costs the learner the hint.
	if (images.length > 0) {
		try {
			const name = hintPageName(toolCallId, n);
			stores.sketchStore.saveHintPage(chatId, name, images.map((i) => new Uint8Array(Buffer.from(i.data, "base64"))), { toolCallId, n, at: new Date().toISOString(), strokeCount, pages: images.length });
		} catch (error) {
			console.error(`[chat ${chatId}] hint page not kept:`, error);
		}
	}
	const practiceEarlier = practice.earlier;
	if (practiceEarlier === null) return Response.json({ hint: stripHintLabel(result.reply), n });

	// A practice hint: split off the size, then write it into the record beside the open problem.
	const given = parseHintReply(result.reply);
	if (!given.text) return Response.json({ error: "The tutor sent an empty hint. Try again." }, { status: 502 });
	// The call took seconds: a turn may have started, or a second press may have landed. The record decides.
	if (isTurnRunning(chatId)) return Response.json({ error: "The tutor is writing right now. Try again in a moment." }, { status: 409 });
	const fresh = stores.chatStore.getChat(chatId);
	if (!fresh) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const now = activeProblemOf(fresh.messages);
	if (!now || now.toolCallId !== toolCallId || practiceHintsOf(fresh.messages, toolCallId).length !== practiceEarlier.length) {
		return Response.json({ error: "That problem changed while the hint was written. Try again." }, { status: 409 });
	}
	try {
		stores.chatStore.saveMessages(chatId, [...fresh.messages, newPracticeHintMarker(toolCallId, n, given.size, given.text)]);
	} catch (error) {
		console.error(`[chat ${chatId}] practice hint not saved:`, error);
		return Response.json({ error: "The hint could not be saved. Try again." }, { status: 500 });
	}
	emit("record-changed", { chatId });
	return Response.json({ hint: given.text, n, size: given.size, hints: [...practiceEarlier, { size: given.size, text: given.text }] });
}
