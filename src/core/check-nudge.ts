/**
 * End a teaching turn with a check (owner, 2026-11-18 — the Taylor lesson on the tablet). PURE, browser-safe.
 *
 * The answer results used to say "teach the next step there — or finish in text", and on the tablet the tutor taught the next
 * step in plain text and stopped with no question open, so the learner had nothing to answer. The wording now allows text only
 * when the plan is done; this is the backstop: when a turn that replies to a teach answer ends in text with no question, the
 * run gets ONE hidden reminder to pose the next check (teacher-agent.ts finishTurn).
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

/** The reminder the model reads (a hidden marker, never shown in the transcript). */
export const CHECK_NUDGE_TEXT =
	"[REMINDER — NOT FROM THE LEARNER] Your last reply ended with no question open, but the plan is not finished. " +
	"Pose the check for the step you just taught now, with quiz or explain (same nodeId rules as always); do not write another explanation first. " +
	"If the plan really is complete, pose the final problem instead.";

const TEACH_QUESTION_TOOLS: ReadonlySet<string> = new Set(["quiz", "explain"]);

interface CallLike {
	type: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

function callOf(history: readonly unknown[], toolCallId: string): CallLike | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i] as { role?: string; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		const hit = (m.content as CallLike[]).find((b) => b.type === "toolCall" && b.id === toolCallId);
		if (hit) return hit;
	}
	return undefined;
}

/**
 * Does this finished assistant message need the reminder? True when it is a plain text stop (no tool call) that replies to a
 * teach answer: walking back over the tutor's own messages and tool results, the nearest thing is an answered quiz or explain
 * that is not the final problem. False for the plan-presentation turn, a turn after a learner message, a probe, an ask, and
 * the final problem's answer (a lesson may end in text).
 */
export function needsCheckNudge(history: readonly unknown[], message: AssistantMessage): boolean {
	if (message.stopReason !== "stop") return false;
	if (message.content.some((b) => b.type === "toolCall")) return false;
	if (!message.content.some((b) => b.type === "text" && b.text.trim().length > 0)) return false;
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i] as { role?: string };
		if (m === (message as unknown)) continue;
		if (m.role === "assistant") continue;
		if (m.role === "toolResult") {
			const result = m as ToolResultMessage;
			if (result.isError) continue;
			if (!TEACH_QUESTION_TOOLS.has(result.toolName)) {
				// a tool the tutor ran in between (read_sketch, material_read, show_figure…) is neither an answer nor a stop
				if (["ask_user_question", "probe", "probe_done", "plan_init", "finish_lesson"].includes(result.toolName)) return false;
				continue;
			}
			const call = callOf(history, result.toolCallId);
			const type = (call?.arguments as { type?: unknown } | undefined)?.type;
			return type !== "final";
		}
		// the learner's dispute of a sketch reading (core/sketch-gate.ts) is about the reading, not a new turn: the answer behind it is still unanswered
		if ((m as { customType?: string }).customType === "sketch-dispute") continue;
		return false; // a user or custom message: the learner spoke, or this is a fresh turn
	}
	return false;
}
