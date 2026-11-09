/**
 * practice-grading — the pure side of the practice grader (owner, 2026-11-09).
 *
 * A concluded problem's per-skill grades used to be the tutor's own claim (the
 * conclude call's `grades`); a lenient tutor graded a hint-assisted solve
 * `good`. A SECOND model now reads the whole problem — pose to conclusion —
 * and grades each tagged skill (agent/subagents/grader.ts). This module slices
 * that span out of the record and renders it as the grader's evidence.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMessage } from "./native-messages.ts";

/** The read_sketch tool's name (agent/tools/sketch.ts), spelled here so core stays free of agent imports. */
const READ_SKETCH = "read_sketch";

const roleOf = (m: LhMessage): string | undefined => (m as { role?: string }).role;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
		.filter((t) => t !== "")
		.join("\n");
}

/** The messages of ONE problem: from the newest cleanly-posed `problem`
 *  call before the conclude call, through the message holding that conclude
 *  call. Empty when the conclude call is not in `messages` or no clean pose
 *  precedes it. */
export function problemSpanOf(messages: readonly LhMessage[], concludeCallId: string): LhMessage[] {
	const end = messages.findIndex((m) => roleOf(m) === "assistant" && (m as AssistantMessage).content.some((b) => b.type === "toolCall" && b.id === concludeCallId));
	if (end < 0) return [];
	const clean = new Set<string>();
	for (const m of messages) {
		if (roleOf(m) === "toolResult" && !(m as ToolResultMessage).isError) clean.add((m as ToolResultMessage).toolCallId);
	}
	for (let i = end; i >= 0; i--) {
		const m = messages[i]!;
		if (roleOf(m) !== "assistant") continue;
		if ((m as AssistantMessage).content.some((b) => b.type === "toolCall" && b.name === PRACTICE_PROBLEM_TOOL && clean.has(b.id))) return messages.slice(i, end + 1);
	}
	return [];
}

/** The skill ids the span's pose tagged (the course's boxes fold over exactly these). */
export function taggedSkillsOf(span: readonly LhMessage[]): string[] {
	for (const m of span) {
		if (roleOf(m) !== "assistant") continue;
		for (const b of (m as AssistantMessage).content) {
			if (b.type !== "toolCall" || b.name !== PRACTICE_PROBLEM_TOOL) continue;
			const skills = (b.arguments as { skills?: unknown } | undefined)?.skills;
			return Array.isArray(skills) ? [...new Set(skills.filter((s): s is string => typeof s === "string"))] : [];
		}
	}
	return [];
}

/** The span as the grader reads it: the problem, its committed solution, what the learner wrote
 *  (with the confidence they stated), every tutor reply, the sketch read-backs and the tutor's
 *  own conclusion. Tool acknowledgements and thinking are left out. */
export function renderProblemSpan(span: readonly LhMessage[], concludeCallId: string): string {
	const lines: string[] = [];
	for (const m of span) {
		const role = roleOf(m);
		if (role === "user") {
			const text = textOf((m as { content?: unknown }).content).trim();
			if (text) lines.push(`LEARNER: ${text}`);
		} else if (role === "custom") {
			const custom = m as { customType?: string; content?: unknown };
			if (custom.customType === "practice-thinking") lines.push(`LEARNER (work submitted):\n${textOf(custom.content).trim()}`);
			else if (custom.customType === "sketch-dispute") lines.push("LEARNER disputes the read-back of their sketch.");
		} else if (role === "assistant") {
			for (const b of (m as AssistantMessage).content) {
				if (b.type === "text") {
					if (b.text.trim()) lines.push(`TUTOR: ${b.text.trim()}`);
				} else if (b.type === "toolCall") {
					const args = (b.arguments ?? {}) as Record<string, unknown>;
					if (b.name === PRACTICE_PROBLEM_TOOL) {
						lines.push(`PROBLEM (${String(args.mode ?? "")}): ${String(args.statement ?? "")}`);
						lines.push(`COMMITTED MODEL SOLUTION (hidden from the learner until the end): ${String(args.modelSolution ?? "")}`);
					} else if (b.name === READ_SKETCH) {
						const uncertain = Array.isArray(args.uncertain) && args.uncertain.length > 0 ? ` (doubtful: ${JSON.stringify(args.uncertain)})` : "";
						lines.push(`SKETCH READ-BACK (the tutor's transcription of the learner's handwriting)${uncertain}: ${String(args.reading ?? "")}`);
					} else if (b.name === PRACTICE_CONCLUDE_TOOL && b.id === concludeCallId) {
						lines.push(
							`TUTOR'S CONCLUSION: outcome ${String(args.outcome)}, hint rung ${String(args.rung)}, miss class ${String(args.missClass)}. Verdict: ${String(args.verdict ?? "")}`,
						);
					}
				}
			}
		}
	}
	return lines.join("\n\n");
}
