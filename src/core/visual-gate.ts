/**
 * The visual gate (owner, 2026-11-10 — the ε-δ lesson on the tablet). PURE,
 * browser-safe.
 *
 * Across the tablet's 14 chats the tutor called `demo` once (after the learner
 * asked for it) and `visual` never, though many lessons are about pictures: the
 * ε-band around a graph, tangent lines, areas. The owner's rule is that every
 * Learn session considers a visual at least once, at planning time: plan_init
 * carries a required `visual` decision (`use`: visual | demo | none, plus a
 * reason). This is the second half: when the plan says a picture is needed, the
 * first teach question (quiz / explain) is refused until a visual or demo job
 * has been dispatched in the chat, so the picture arrives before the learner is
 * questioned on the concept, not after he is stuck.
 *
 * Enforced at the same tool-call boundary as the prose gate (teacher-agent.ts
 * beforeToolCall). `use: none` (with its reason) and a plan that predates the
 * field are never gated. The gate only applies when the tool the plan named is
 * available to the tutor, so a learner who switched it off is never deadlocked.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { LEAD_TOOLS } from "./tutor-prose.ts";

/** The tools that put a picture in the lesson (both fire-and-forget background jobs). */
export const VISUAL_TOOLS: readonly string[] = ["visual", "demo"];

export const VISUAL_GATE_REASON =
	"Refused: your plan says this lesson needs a picture (`visual.use` in plan_init), and none has been dispatched yet. " +
	"Dispatch it now with `visual` (a static figure) or `demo` (something to sweep or animate): write a precise, self-contained brief, " +
	"tell the learner in a sentence that it is on its way, and keep teaching, then call the question again. " +
	"If no picture would help after all, call plan_init again with `visual.use` set to `none` and a one-line reason.";

/** What the newest successful plan_init chose for `visual.use`, or undefined (no plan, an old plan without the field). */
function plannedVisual(history: readonly unknown[]): string | undefined {
	const failed = new Set<string>();
	for (const m of history) {
		const r = m as ToolResultMessage;
		if (r.role === "toolResult" && r.isError) failed.add(r.toolCallId);
	}
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i] as { role?: string };
		if (m.role !== "assistant") continue;
		const blocks = (m as AssistantMessage).content;
		for (let j = blocks.length - 1; j >= 0; j--) {
			const block = blocks[j]!;
			if (block.type !== "toolCall" || block.name !== "plan_init" || failed.has(block.id)) continue;
			const visual = (block.arguments as { visual?: { use?: unknown } } | null | undefined)?.visual;
			return typeof visual?.use === "string" ? visual.use : undefined;
		}
	}
	return undefined;
}

/** Has a visual or demo job been dispatched in this conversation (a failed call dispatches nothing)? */
function dispatched(history: readonly unknown[]): boolean {
	return history.some((m) => {
		const r = m as ToolResultMessage;
		return r.role === "toolResult" && !r.isError && VISUAL_TOOLS.includes(r.toolName);
	});
}

/**
 * Should this teach question be refused until the planned picture is
 * dispatched? `available` = the names of the tools the tutor has this turn.
 */
export function visualGateBlocks(history: readonly unknown[], toolName: string, available: readonly string[]): boolean {
	if (!LEAD_TOOLS.includes(toolName)) return false;
	const use = plannedVisual(history);
	if (use !== "visual" && use !== "demo") return false;
	if (!VISUAL_TOOLS.some((tool) => available.includes(tool))) return false;
	return !dispatched(history);
}
