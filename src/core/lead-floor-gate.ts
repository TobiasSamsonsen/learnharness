/**
 * The lead floor (owner, 2026-11-10 — the ε-δ lesson on the tablet). PURE,
 * browser-safe.
 *
 * The prose gate (prose-gate.ts) only asks that SOMETHING reached the learner
 * since his last graded answer, and `lead` has `minLength: 1`, so a one-line
 * filler passed it: after a wrong or "don't know" answer the leads were 32, 39,
 * 39 and 59 characters while the actual diagnosis sat in the thinking block,
 * and the learner wrote that nobody had explained anything. The leads that
 * helped were 592 to 1580 characters.
 *
 * The rule, enforced at the same tool-call boundary: when the learner's last
 * graded answer was wrong or "don't know", the prose that has reached him since
 * (text blocks, question leads and send_to_user messages, the call's own lead
 * included) must total at least LEAD_FLOOR_CHARS, or the question is refused.
 * A correct answer keeps the plain presence rule, so a short acknowledgement is
 * still fine there. The learner typing a message of his own resets the walk.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { sendToUserText } from "./native-messages.ts";
import { NO_LEAD_GATED_TOOLS, PROSE_GATED_TOOLS } from "./prose-gate.ts";
import { leadOf, tutorProse } from "./tutor-prose.ts";

/** The shortest response that counts as an explanation after a miss. */
export const LEAD_FLOOR_CHARS = 150;

/** Tool results that carry the learner's graded answer (same set as the prose gate). */
const GRADED_ANSWER_TOOLS: ReadonlySet<string> = new Set(["quiz", "explain", "probe", "recall"]);

const REASON_HEAD = `Refused: the learner's last answer was wrong or "don't know", and what has reached him since is under ${LEAD_FLOOR_CHARS} characters. `;
const REASON_TAIL =
	"Say what his answer shows and repair it: the step he is missing, worked out in words and symbols, not a nudge or a hint at what to do. " +
	"A call that repeats a one-line filler will be refused again.";

/** The refusal for a question that carries a `lead` (quiz, explain). */
export const LEAD_FLOOR_REASON = REASON_HEAD + "Put the repair in `lead`, then call the question again with it. " + REASON_TAIL;

/** The refusal for a question without a `lead` (ask_user_question): the reply goes through send_to_user. */
export const LEAD_FLOOR_REASON_NO_LEAD = REASON_HEAD + "Send the repair with send_to_user first, then call the question again. " + REASON_TAIL;

/** The refusal text for a gated tool. */
export function leadFloorReason(toolName: string): string {
	return NO_LEAD_GATED_TOOLS.includes(toolName) ? LEAD_FLOOR_REASON_NO_LEAD : LEAD_FLOOR_REASON;
}

/** Was this graded answer wrong, or a "don't know"? Reads the compact result the model sees, then the full record. */
function isMiss(result: ToolResultMessage): boolean {
	const readable = (value: unknown): boolean | undefined => {
		if (!value || typeof value !== "object") return undefined;
		const answer = value as { correct?: unknown; dontKnow?: unknown };
		if (answer.correct === false || answer.dontKnow === true) return true;
		if (answer.correct === true) return false;
		return undefined;
	};
	for (const block of result.content) {
		if (block.type !== "text") continue;
		try {
			const verdict = readable(JSON.parse(block.text));
			if (verdict !== undefined) return verdict;
		} catch {
			// not JSON: fall through to the record
		}
	}
	return readable(result.details) ?? false;
}

/** The visible prose of one assistant message, in characters (a call in `rejected` was never posed: nothing in it was shown). */
function proseChars(blocks: AssistantMessage["content"], rejected: ReadonlySet<string>): number {
	let total = 0;
	for (const text of tutorProse(blocks, rejected)) total += text.trim().length;
	for (const block of blocks) {
		const sent = sendToUserText(block);
		if (sent !== undefined && !(block.type === "toolCall" && rejected.has(block.id))) total += sent.trim().length;
	}
	return total;
}

/**
 * Should this question call be refused for a too-short response to a miss?
 * `history` = the conversation before (or including — it is skipped) the
 * calling message. False for a tool the prose gate does not guard, for a
 * correct last answer, and when the learner has spoken since.
 */
export function leadFloorBlocks(
	history: readonly unknown[],
	assistantMessage: AssistantMessage,
	toolCallId: string,
	toolName: string,
): boolean {
	if (!PROSE_GATED_TOOLS.includes(toolName)) return false;
	const rejected = new Set<string>();
	for (const m of history) {
		const r = m as ToolResultMessage;
		if (r.role === "toolResult" && r.isError) rejected.add(r.toolCallId);
	}
	// this message: text before the call, and the call's own lead
	const at = assistantMessage.content.findIndex((b) => b.type === "toolCall" && b.id === toolCallId);
	const before = assistantMessage.content.slice(0, at < 0 ? assistantMessage.content.length : at);
	let chars = proseChars(before, rejected);
	if (at >= 0) chars += leadOf(assistantMessage.content[at]!).trim().length;
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i] as { role?: string };
		if (m === assistantMessage) continue;
		if (m.role === "assistant") {
			chars += proseChars((m as AssistantMessage).content, rejected);
			continue;
		}
		if (m.role === "toolResult") {
			const result = m as ToolResultMessage;
			if (result.isError || !GRADED_ANSWER_TOOLS.has(result.toolName)) continue;
			return isMiss(result) && chars < LEAD_FLOOR_CHARS;
		}
		if (m.role === "user") return false;
	}
	return false;
}
