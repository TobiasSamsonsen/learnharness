/**
 * final-problem — the unaided problem that ends a course Learn session
 * (owner, 2026-11-13). Finishing a lesson used to count as `good` whatever
 * happened in it, and the first practice afterwards mostly needed hints. Now
 * the teacher poses ONE final problem (`explain` with type "final", always
 * free-form), `finish_lesson` is refused until one has been answered, and the
 * practice grader rates it: that grade is the skill's first rating, and an
 * `again` turns the finish back (agent/lesson-grade.ts).
 *
 * Pure: the gate, the span the grader reads, and its rendering.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { FINISH_LESSON_TOOL } from "./course-session.ts";
import type { LhMessage } from "./native-messages.ts";
import { normalizeQuizType } from "./question-core.ts";

/** The free-recall teach tool: the final problem is one of its calls. */
const EXPLAIN_TOOL = "explain";
const READ_SKETCH = "read_sketch";

const roleOf = (m: unknown): string | undefined => (m as { role?: string }).role;

const isFinalCall = (b: AssistantMessage["content"][number]): boolean =>
	b.type === "toolCall" && b.name === EXPLAIN_TOOL && normalizeQuizType((b.arguments as { type?: unknown } | undefined)?.type) === "final";

/** Where the newest ANSWERED final problem stands: the index of the message that posed it, its call id, and whether the
 *  learner pressed "I don't know". Null when no final problem has been answered. */
export function lastFinalProblemOf(messages: readonly unknown[]): { index: number; callId: string; dontKnow: boolean } | null {
	const answers = new Map<string, unknown>();
	for (const m of messages) {
		const r = m as ToolResultMessage;
		// an answered question's result carries the answer record; a posed-only or refused call does not
		if (roleOf(m) === "toolResult" && r.toolName === EXPLAIN_TOOL && !r.isError && r.details != null) answers.set(r.toolCallId, r.details);
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		if (roleOf(messages[i]) !== "assistant") continue;
		for (const b of (messages[i] as AssistantMessage).content) {
			if (!isFinalCall(b) || b.type !== "toolCall" || !answers.has(b.id)) continue;
			const details = answers.get(b.id) as { dontKnow?: unknown; dismissed?: unknown };
			if (details.dismissed === true) continue;
			return { index: i, callId: b.id, dontKnow: details.dontKnow === true };
		}
	}
	return null;
}

/** The index of the newest `finish_lesson` call before `beforeCallId` (or any, when it is absent); -1 when none. */
function lastFinishAttempt(messages: readonly unknown[], exceptCallId: string): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (roleOf(messages[i]) !== "assistant") continue;
		if ((messages[i] as AssistantMessage).content.some((b) => b.type === "toolCall" && b.name === FINISH_LESSON_TOOL && b.id !== exceptCallId)) return i;
	}
	return -1;
}

/** Why a `finish_lesson` call must wait, or null when it may go through: a final problem has to be answered (and not
 *  with "I don't know") since the last finish attempt. `history` may or may not hold the calling message. */
export function finishGateProblem(history: readonly unknown[], toolName: string, toolCallId: string): "none" | "dontKnow" | null {
	if (toolName !== FINISH_LESSON_TOOL) return null;
	const final = lastFinalProblemOf(history);
	if (!final || final.index < lastFinishAttempt(history, toolCallId)) return "none";
	return final.dontKnow ? "dontKnow" : null;
}

export const FINISH_GATE_REASON_NONE =
	"Refused: a lesson finishes only after ONE final problem. Pose it now with `explain` and type \"final\": a fresh case that takes the whole skill, " +
	"with no hint in its lead. Call `finish_lesson` again after the learner has answered it.";

export const FINISH_GATE_REASON_DONT_KNOW =
	"Refused: the learner did not know the final problem, so the lesson is not finished. Teach the gap it showed, " +
	"then pose a NEW final problem with `explain` and type \"final\": a different case, never the one you just explained. Call `finish_lesson` again after the learner has answered it.";

export function finishGateReason(problem: "none" | "dontKnow"): string {
	return problem === "none" ? FINISH_GATE_REASON_NONE : FINISH_GATE_REASON_DONT_KNOW;
}

/** What `finish_lesson` returns when the grader rated the final problem `again`: the finish did not go through. */
export const FINISH_NOT_PASSED_TEXT =
	"NOT FINISHED: the grader rated the final problem as not solved unaided, so the skill is not learned yet. Tell the learner plainly, " +
	"teach the gap the final problem showed, then pose a NEW final problem with `explain` and type \"final\" (a different case, never the one you just explained) and call `finish_lesson` again after the answer.";

/** The messages the grader reads for a finish: from the message that posed the newest answered final problem through
 *  the message holding the finish call. Empty when there is no such problem before the call. */
export function finalProblemSpanOf(messages: readonly LhMessage[], finishCallId: string): LhMessage[] {
	const end = messages.findIndex((m) => roleOf(m) === "assistant" && (m as AssistantMessage).content.some((b) => b.type === "toolCall" && b.id === finishCallId));
	if (end < 0) return [];
	const final = lastFinalProblemOf(messages.slice(0, end + 1));
	return final ? messages.slice(final.index, end + 1) : [];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
		.filter((t) => t !== "")
		.join("\n");
}

/** The span as the grader reads it: the final problem and its committed answer, what the learner wrote, the sketch
 *  read-backs, every tutor reply, and the tutor's finish summary. Thinking and tool acknowledgements are left out. */
export function renderFinalProblemSpan(span: readonly LhMessage[], finishCallId: string): string {
	const lines: string[] = [];
	let finalCallId: string | undefined;
	for (const m of span) {
		const role = roleOf(m);
		if (role === "assistant") {
			for (const b of (m as AssistantMessage).content) {
				if (b.type === "text") {
					if (b.text.trim()) lines.push(`TUTOR: ${b.text.trim()}`);
				} else if (b.type === "toolCall") {
					const args = (b.arguments ?? {}) as Record<string, unknown>;
					if (isFinalCall(b) && finalCallId === undefined) {
						finalCallId = b.id;
						lines.push(`FINAL PROBLEM (posed with no hints; the learner works alone): ${String(args.question ?? "")}`);
						lines.push(`COMMITTED CORRECT ANSWER (hidden from the learner until they submit): ${String(args.correctAnswer ?? "")}`);
					} else if (b.name === READ_SKETCH) {
						const uncertain = Array.isArray(args.uncertain) && args.uncertain.length > 0 ? ` (doubtful: ${JSON.stringify(args.uncertain)})` : "";
						lines.push(`SKETCH READ-BACK (the tutor's transcription of the learner's handwriting)${uncertain}: ${String(args.reading ?? "")}`);
					} else if (b.name === "send_to_user") {
						const message = String(args.message ?? "").trim();
						if (message) lines.push(`TUTOR: ${message}`);
					} else if (b.name === FINISH_LESSON_TOOL && b.id === finishCallId) {
						lines.push(`TUTOR'S FINISH SUMMARY: ${String(args.summary ?? "")}`);
					}
				}
			}
		} else if (role === "toolResult") {
			const r = m as ToolResultMessage;
			if (r.toolCallId !== finalCallId || r.isError || r.details == null) continue;
			const d = r.details as { dontKnow?: unknown; text?: unknown; thinking?: unknown; sketch?: unknown };
			if (d.dontKnow === true) lines.push("LEARNER: pressed \"I don't know\".");
			else {
				const text = typeof d.text === "string" ? d.text.trim() : "";
				lines.push(`LEARNER'S ANSWER: ${text || (d.sketch ? "(handwritten: see the sketch read-back)" : "(empty)")}`);
			}
			if (typeof d.thinking === "string" && d.thinking.trim()) lines.push(`LEARNER'S THINKING: ${d.thinking.trim()}`);
		} else if (role === "user") {
			const text = textOf((m as { content?: unknown }).content).trim();
			if (text) lines.push(`LEARNER: ${text}`);
		} else if (role === "custom" && (m as { customType?: string }).customType === "sketch-dispute") {
			lines.push("LEARNER disputes the read-back of their sketch.");
		}
	}
	return lines.join("\n\n");
}

// ─── the recall opener (owner, 2026-11-13) ──────────────────────────────────

const isRecallCall = (b: AssistantMessage["content"][number]): boolean =>
	b.type === "toolCall" && b.name === EXPLAIN_TOOL && normalizeQuizType((b.arguments as { type?: unknown } | undefined)?.type) === "recall";

const QUESTION_TOOL_NAMES: readonly string[] = ["quiz", "explain", "ask_user_question"];

/** The lesson's answered recall openers before the finish call: the earlier skill each tested and the evidence the
 *  grader reads (the question, the committed answer, what the learner wrote and thought, the sketch read-backs that
 *  followed). A refused, unanswered or dismissed opener is left out. */
export function recallOpenersOf(messages: readonly LhMessage[], finishCallId: string): Array<{ skill: string; callId: string; transcript: string }> {
	const end = messages.findIndex((m) => roleOf(m) === "assistant" && (m as AssistantMessage).content.some((b) => b.type === "toolCall" && b.id === finishCallId));
	const upTo = end < 0 ? messages.length : end;
	const out: Array<{ skill: string; callId: string; transcript: string }> = [];
	for (let i = 0; i < upTo; i++) {
		if (roleOf(messages[i]) !== "assistant") continue;
		for (const b of (messages[i] as AssistantMessage).content) {
			if (b.type !== "toolCall" || !isRecallCall(b)) continue;
			const args = (b.arguments ?? {}) as Record<string, unknown>;
			const skill = typeof args.skill === "string" ? args.skill : "";
			if (!skill) continue;
			const resultAt = messages.findIndex((m, j) => j > i && roleOf(m) === "toolResult" && (m as ToolResultMessage).toolCallId === b.id);
			if (resultAt < 0) continue;
			const r = messages[resultAt] as ToolResultMessage;
			const d = r.details as { dontKnow?: unknown; dismissed?: unknown; text?: unknown; thinking?: unknown; sketch?: unknown } | null | undefined;
			if (r.isError || !d || d.dismissed === true) continue;
			const lines = [
				`RECALL QUESTION (posed with no hints; the learner works alone): ${String(args.question ?? "")}`,
				`COMMITTED CORRECT ANSWER (hidden from the learner until they submit): ${String(args.correctAnswer ?? "")}`,
			];
			if (d.dontKnow === true) lines.push("LEARNER: pressed \"I don't know\".");
			else {
				const text = typeof d.text === "string" ? d.text.trim() : "";
				lines.push(`LEARNER'S ANSWER: ${text || (d.sketch ? "(handwritten: see the sketch read-back)" : "(empty)")}`);
			}
			if (typeof d.thinking === "string" && d.thinking.trim()) lines.push(`LEARNER'S THINKING: ${d.thinking.trim()}`);
			// the sketch read-backs between this answer and the next question
			for (let k = resultAt + 1; k < upTo; k++) {
				if (roleOf(messages[k]) !== "assistant") continue;
				const blocks = (messages[k] as AssistantMessage).content;
				for (const rb of blocks) {
					if (rb.type !== "toolCall") continue;
					if (rb.name === READ_SKETCH) lines.push(`SKETCH READ-BACK (the tutor's transcription of the learner's handwriting): ${String((rb.arguments as { reading?: unknown } | undefined)?.reading ?? "")}`);
				}
				if (blocks.some((rb) => rb.type === "toolCall" && QUESTION_TOOL_NAMES.includes(rb.name))) break;
			}
			out.push({ skill, callId: b.id, transcript: lines.join("\n\n") });
		}
	}
	return out;
}
