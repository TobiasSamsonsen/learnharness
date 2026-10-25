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
	"and only then call the question again, in the same message after that text.";

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
