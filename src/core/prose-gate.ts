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

/** The teach-side question tools the gate guards. */
export const PROSE_GATED_TOOLS: readonly string[] = ["quiz", "explain"];

/** Tool results that carry the learner's graded answer. */
const GRADED_ANSWER_TOOLS: ReadonlySet<string> = new Set(["quiz", "explain", "probe", "recall"]);

export const PROSE_GATE_REASON =
	"Refused: the learner just answered, and nothing you have written since has reached him — your thinking is invisible to him. " +
	"Respond to his answer in text first (what it shows; if it was wrong, diagnose and repair), then teach the next step in text, " +
	"and only then call the question again, in the same message after that text. " +
	"Your last message had no text; calling the question again without text will be refused again. Write the text first.";

/** The just-in-time half (owner, 2026-10-25 — the mutable-types lesson:
 *  the gate fired on 6 of 7 checks and the retries passed it with one
 *  filler line). Rides every gated tool's answer result as `next`, so
 *  the rule is in front of the model at the moment it decides; the gate
 *  stays the backstop. */
export const ANSWER_NEXT_TEXT =
	"Reply in text before any tool: what this answer shows (wrong: diagnose and repair). " +
	"Then teach the next step in text before its question — or finish. " +
	"Do not plan the reply in thinking: only text reaches him.";

/** The same, for an answer that carries a SKETCH (Android plan M2): the
 *  read comes first — the plain "reply in text before any tool" would have
 *  the tutor grade handwriting it never transcribed. */
export const SKETCH_ANSWER_NEXT_TEXT =
	"A sketch is attached: call read_sketch on it first, in this reply — before any other tool or text. " +
	"Then reply in text: what this answer shows (wrong: diagnose and repair). " +
	"Then teach the next step in text before its question — or finish.";

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

const hasText = (blocks: AssistantMessage["content"]): boolean =>
	blocks.some((b) => b.type === "text" && b.text.trim().length > 0);

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
	// text before this call in the calling message itself
	const at = assistantMessage.content.findIndex((b) => b.type === "toolCall" && b.id === toolCallId);
	if (hasText(assistantMessage.content.slice(0, at < 0 ? assistantMessage.content.length : at))) return false;
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i] as { role?: string };
		if (m === assistantMessage) continue;
		if (m.role === "assistant") {
			if (hasText((m as AssistantMessage).content)) return false;
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
