import { carryOverInk } from "./ink-memory.ts";

/**
 * A re-asked question keeps the learner's page (owner plan, 2026-11-15). Ink lives under the tool-call id, and a re-ask on the
 * SAME node is a new call with a new id: without this the page comes up blank and the work stays behind on the old call.
 * Only the newest earlier call on the node counts, and only a call that was already answered (the dock never holds two).
 */
interface ViewMessage {
	parts: Array<Record<string, unknown> & { type: string }>;
}

const QUESTION_TOOL_TYPES = new Set(["tool-quiz", "tool-probe", "tool-ask_user_question", "tool-explain", "tool-recall"]);

export function previousCallOnNode(messages: readonly ViewMessage[], pendingCallId: string, nodeId: string): string | null {
	let found: string | null = null;
	for (const m of messages) {
		for (const p of m.parts) {
			if (!QUESTION_TOOL_TYPES.has(p.type) || typeof p.toolCallId !== "string") continue;
			if (p.toolCallId === pendingCallId) return found; // everything after the pending call is irrelevant
			const input = p.input as { nodeId?: unknown } | undefined;
			if (input?.nodeId === nodeId && p.state === "output-available") found = p.toolCallId;
		}
	}
	return found;
}

/** Move the unsent ink of the previous call on this node onto the pending call's page, when that page is still empty. */
export function carryInkToReask(messages: readonly ViewMessage[], pendingCallId: string, input: unknown): boolean {
	const nodeId = (input as { nodeId?: unknown } | null)?.nodeId;
	if (typeof nodeId !== "string") return false;
	const from = previousCallOnNode(messages, pendingCallId, nodeId);
	return from !== null && carryOverInk(from, pendingCallId);
}
