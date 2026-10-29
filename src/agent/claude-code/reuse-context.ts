import type { Api, Message, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

import { normalizeSketchContent } from "./fork-extensions.ts";

/** Compare model-visible history, not app IDs, timestamps, usage, or Pi's added thinkingLevel. */
export function conversationForReuse(messages: Message[]): unknown[] {
	return messages.flatMap((message): unknown[] => {
		switch (message.role) {
			case "system": return [];
			case "user": return [{ role: message.role, content: normalizeSketchContent(message.content) }]; // fork: P2
			case "assistant": return [{ role: message.role, content: message.content }];
			case "toolResult": return [{
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: normalizeSketchContent(message.content), // fork: P2
				isError: message.isError,
			}];
		}
	});
}

export function configurationForReuse(model: Model<Api>, context: TranscriptContext, effort: string): unknown {
	const systemPrompt = getCurrentSystemPrompt(context.messages);
	const tools = getCurrentTools(context.messages);
	// The wire is JSON: TypeBox's schema symbols are not CLI configuration.
	return JSON.parse(JSON.stringify({ model, effort, systemPrompt, tools })) as unknown;
}
