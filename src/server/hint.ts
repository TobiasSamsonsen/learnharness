import { HINT_MAX, HINT_THINKING_MAX, hintEligible, hintPrompt, hintsOf } from "../core/hints.ts";
import { hasProbeDone } from "../core/native-messages.ts";
import type { PiEngine } from "../agent/models.ts";
import { tutorSideCall } from "./clarify.ts";
import { stores } from "./stores.ts";

/**
 * POST /api/chats/[id]/hint — body {toolCallId, earlier: string[], thinking?}: one hint on the pending lesson question
 * (owner, 2026-11-13 — core/hints.ts). ONE text-only call on the chat's own model with the lesson so far, the
 * clarification call's twin (tutorSideCall): nothing enters `messages`, the question stays open. The hints live with
 * the dock and ride the learner's answer; this route only writes the call's usage. Answers {hint, n}.
 */
export async function handleHintRequest(chatId: string, body: unknown, engineOverride?: PiEngine): Promise<Response> {
	const raw = (body ?? {}) as { toolCallId?: unknown; earlier?: unknown; thinking?: unknown };
	if (typeof raw.toolCallId !== "string" || !raw.toolCallId) return Response.json({ error: "toolCallId is required" }, { status: 400 });
	const toolCallId = raw.toolCallId;
	const earlier = hintsOf(raw.earlier);
	if (Array.isArray(raw.earlier) && raw.earlier.length >= HINT_MAX) return Response.json({ error: `A question has at most ${HINT_MAX} hints` }, { status: 400 });
	const thinking = typeof raw.thinking === "string" ? raw.thinking.slice(0, HINT_THINKING_MAX) : undefined;
	if (!stores.chatStore.getChat(chatId)) return Response.json({ error: "Unknown chat" }, { status: 404 });

	const n = earlier.length + 1;
	const result = await tutorSideCall(
		chatId,
		({ record, pending }) => {
			// Read after the awaits: the learner may have answered meanwhile.
			if (!pending || pending.toolCallId !== toolCallId) return Response.json({ error: "That question is no longer open" }, { status: 409 });
			const phase = hasProbeDone(record.messages) ? "teach" : "probe";
			if (!hintEligible(pending.tool, pending.input, phase)) return Response.json({ error: "This question has no hints" }, { status: 400 });
			return hintPrompt({ n, earlier, ...(thinking ? { thinking } : {}) });
		},
		{ usageId: `hint_${crypto.randomUUID()}`, label: "hint", failure: "The tutor could not give a hint just now. Try again.", empty: "The tutor sent an empty hint. Try again." },
		engineOverride,
	);
	if (result instanceof Response) return result;
	return Response.json({ hint: result.reply, n });
}
