/**
 * The prose gate (owner, 2026-10-25 — the ITGK lesson). PURE, browser-safe.
 *
 * The teaching doctrine says "teach first, check second" and "a wrong
 * answer means resume teaching", but a model can satisfy itself in
 * private: twenty times in one lesson the teacher planned its response in
 * thinking ("I'll show this with a table…") and fired the next quiz with
 * no visible text, so the learner got question after question and never
 * an explanation. Thinking is invisible to the learner; only text reaches
 * him.
 *
 * The rule, enforced at the tool-call boundary (teacher-agent.ts
 * beforeToolCall): a graded teach question (quiz / explain) is refused
 * when NO text has reached the learner since his last graded answer. The
 * learner typing a message of his own resets the walk (his message is
 * not an answer to respond to).
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { sendToUserText } from "./native-messages.ts";
import { LEAD_TOOLS, leadOf, tutorProse } from "./tutor-prose.ts";

/** The teach-side question tools without a `lead`, which the gate guards too (owner, 2026-11-05: on the tablet an
 *  `ask_user_question` after a "don't know" carried NO prose while the explanation sat in the thinking summary, so the
 *  learner got a bare question). Their reply rides in `send_to_user` or in plain text before the call. */
export const NO_LEAD_GATED_TOOLS: readonly string[] = ["ask_user_question"];

/** The teach-side question tools the gate guards: the ones that carry a `lead` (since 2026-10-27 the reply the learner
 *  reads rides in the call) and the ones that do not. */
export const PROSE_GATED_TOOLS: readonly string[] = [...LEAD_TOOLS, ...NO_LEAD_GATED_TOOLS];

/** Tool results that carry the learner's graded answer. */
const GRADED_ANSWER_TOOLS: ReadonlySet<string> = new Set(["quiz", "explain", "probe", "recall"]);

const REASON_HEAD =
	"Refused: the learner just answered, and nothing you have written since has reached him — your thinking is invisible to him. ";

export const PROSE_GATE_REASON =
	REASON_HEAD +
	"Put your response to his answer in `lead` (what it shows; if it was wrong, diagnose and repair), then teach the next step there, " +
	"and call the question again with that `lead`. A call without it will be refused again.";

/** The same refusal for a question without a `lead` (ask_user_question): the reply goes through send_to_user, or plain
 *  text when you have no such tool. Shares its first words with PROSE_GATE_REASON: `proseGateRefusedLast` matches them. */
export const PROSE_GATE_REASON_NO_LEAD =
	REASON_HEAD +
	"Send your response to his answer first, with send_to_user (plain text before the call only if you have no send_to_user): " +
	"what it shows; if it was wrong, diagnose and repair. Then call the question again. A call without it will be refused again.";

/** The refusal text for a gated tool. */
export function proseGateReason(toolName: string): string {
	return NO_LEAD_GATED_TOOLS.includes(toolName) ? PROSE_GATE_REASON_NO_LEAD : PROSE_GATE_REASON;
}

/** The just-in-time half (owner, 2026-10-25 — the mutable-types lesson:
 *  the gate fired on 6 of 7 checks and the retries passed it with one
 *  filler line). Rides every gated tool's answer result as `next`, so
 *  the rule is in front of the model at the moment it decides; the gate
 *  stays the backstop. */
export const ANSWER_NEXT_TEXT =
	"Reply in the next question's `lead`: what this answer shows (wrong: diagnose and repair), " +
	"then teach the next step there — or finish in text. " +
	"Do not plan the reply in thinking: only text and `lead` reach him.";

/** The same, for an answer that carries a SKETCH (Android plan M2): the
 *  read comes first — the plain "reply in text before any tool" would have
 *  the tutor grade handwriting it never transcribed. */
export const SKETCH_ANSWER_NEXT_TEXT =
	"A sketch is attached: call read_sketch on it first, in this reply — before any other tool or text. " +
	"Then reply in the next question's `lead`: what this answer shows (wrong: diagnose and repair), " +
	"then teach the next step there — or finish in text. " +
	"Do not plan the reply in thinking: only text and `lead` reach him. Work the correct answer out before you write; never correct yourself inside `lead`.";

/** And for a sketch on a question that is not prose-gated (ask, probe). */
export const SKETCH_READ_FIRST_TEXT =
	"A sketch is attached: call read_sketch on it first, in this reply, then respond to the work.";

/** Was the newest thing in the transcript this gate's own refusal (the run of
 *  tool results at its end holds a refused question)? The force-text step
 *  (teacher-agent.ts) keys on it: the next request is text-only. */
export function proseGateRefusedLast(history: readonly unknown[]): boolean {
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i] as { role?: string };
		if (m.role !== "toolResult") return false;
		const result = m as ToolResultMessage;
		if (
			result.isError &&
			PROSE_GATED_TOOLS.includes(result.toolName) &&
			result.content.some((b) => b.type === "text" && b.text.startsWith(PROSE_GATE_REASON.slice(0, 60)))
		)
			return true;
	}
	return false;
}

/** Prose reached the learner: a text block, a question call's `lead`, or a
 *  `send_to_user` message (Claude's explicit output channel; a call in
 *  `rejected` was never posed or delivered, so nothing in it was shown). */
const hasText = (blocks: AssistantMessage["content"], rejected?: ReadonlySet<string>): boolean =>
	tutorProse(blocks, rejected).length > 0 ||
	blocks.some((b) => sendToUserText(b) !== undefined && !(b.type === "toolCall" && rejected?.has(b.id)));

/**
 * Should this question call be refused? `history` = the conversation
 * before (or including — it is skipped) the calling message.
 */
export function proseGateBlocks(
	history: readonly unknown[],
	assistantMessage: AssistantMessage,
	toolCallId: string,
	toolName: string,
): boolean {
	if (!PROSE_GATED_TOOLS.includes(toolName)) return false;
	// the call's own lead, or text before it in the calling message itself
	const at = assistantMessage.content.findIndex((b) => b.type === "toolCall" && b.id === toolCallId);
	if (at >= 0 && leadOf(assistantMessage.content[at]!) !== "") return false;
	if (hasText(assistantMessage.content.slice(0, at < 0 ? assistantMessage.content.length : at))) return false;
	// calls that errored back (authoring rejections, this gate's own refusals)
	// were never posed: their lead never reached the learner
	const rejected = new Set<string>();
	for (const m of history) {
		const r = m as ToolResultMessage;
		if (r.role === "toolResult" && r.isError) rejected.add(r.toolCallId);
	}
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i] as { role?: string };
		if (m === assistantMessage) continue;
		if (m.role === "assistant") {
			if (hasText((m as AssistantMessage).content, rejected)) return false;
			continue;
		}
		if (m.role === "toolResult") {
			// an ERROR result is a rejected call (authoring validation, this
			// gate's own refusal) — never the learner's answer
			const result = m as ToolResultMessage;
			if (!result.isError && GRADED_ANSWER_TOOLS.has(result.toolName)) return true;
			continue;
		}
		if (m.role === "user") return false;
		// markers (plan blocks, steers, context) are neither prose nor an answer
	}
	return false;
}
