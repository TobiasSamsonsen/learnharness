import type { ToolCallHooks } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { SEND_TO_USER_TOOL, sendToUserText } from "../core/native-messages.ts";
import { isNarrationSignature } from "../core/narration-signature.ts";
import { sendToUserApplies } from "./tools/send-to-user.ts";

export const NARRATION_GUARD_MAX_BLOCKS = 2;

export const NARRATION_BLOCK_REASON =
	"This response contains narration: hidden text that never reaches the learner, and what you meant to tell him (a correction, an explanation) may be in it. Put everything the learner needs in the question's `lead` (or send it through `send_to_user`) and keep it out of narration, then retry this question. Deliver learner-facing content, not internal reasoning.";

export const SEND_TO_USER_DELIVERY_RULE =
	"## Delivering your prose\n\n" +
	"Deliver learner-facing prose through `send_to_user`; ordinary response text may be converted into summarized thinking instead of reaching the learner. " +
	"Send the complete explanation, example, or commentary before calling the accompanying question tool. " +
	"Question-only turns do not require an extra message. " +
	"A question whose response contains narration but no delivered prose may be rejected so you can deliver the missing explanation and retry.";

export function narrationGuardApplies(
	kind: string,
	model: { provider: string; id: string },
	toolsOverridden: boolean,
): boolean {
	return kind === "teacher" && sendToUserApplies(kind, model, toolsOverridden);
}

export function isNarrationBlock(block: { type: string; thinkingSignature?: string }): boolean {
	return block.type === "thinking" && isNarrationSignature(block.thinkingSignature);
}

export function questionLacksDeliveredProse(message: AssistantMessage, toolName: string, delivered = false): boolean {
	if (!(QUESTION_TOOLS as readonly string[]).includes(toolName)) return false;
	if (!message.content.some(isNarrationBlock as (b: AssistantMessage["content"][number]) => boolean)) return false;
	// Owner, 2026-11-14: a narration block means the tutor's reply may have gone into hidden text, so a lead no longer
	// counts as delivery, however long (a 230-character lead beside a narration block carried none of the correction, and the
	// learner read the correction in the thinking row). Only a text block or a delivered send_to_user does.
	return !delivered && !message.content.some((b) => b.type === "text" && b.text.trim().length > 0);
}

export function makeNarrationGuard(): ToolCallHooks {
	let blocked = 0;
	// The sequential output/question tools run in call order. Credit only a
	// successful output already executed for THIS response, never a later
	// call, an older lesson, or a failed/aborted output. State is run-local.
	const delivered = new WeakSet<AssistantMessage>();
	return {
		beforeToolCall: async ({ assistantMessage, toolCall }) => {
			if (blocked >= NARRATION_GUARD_MAX_BLOCKS) return undefined;
			if (!questionLacksDeliveredProse(assistantMessage, toolCall.name, delivered.has(assistantMessage))) return undefined;
			blocked++;
			return { block: true, reason: NARRATION_BLOCK_REASON };
		},
		afterToolCall: async ({ assistantMessage, toolCall, result, isError }) => {
			if (toolCall.name === SEND_TO_USER_TOOL && !isError && !result.isError && sendToUserText(toolCall) !== undefined) {
				delivered.add(assistantMessage);
			}
			return undefined;
		},
	};
}
