/**
 * The sources gate (owner, 2026-11-13). PURE, browser-safe.
 *
 * Across 22 tablet chats the tutor searched the course's sources once, and only after the learner asked for the full
 * syllabus, though the sources hold the exams that show what a skill is tested on and the course's own definitions
 * and notation. In a course Learn session that has sources, `plan_init` is now refused until the tutor has looked in
 * them (material_search / material_read), and the first plan must say in its `sources` field what it found and what
 * the plan uses. Enforced at the same tool-call boundary as the other teacher gates (teacher-agent.ts beforeToolCall),
 * and only when the tutor actually has the search tool, so a session without sources is never held up.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

/** The tools that look in the course's sources. */
export const SOURCE_TOOLS: readonly string[] = ["material_search", "material_read"];

export const SOURCES_GATE_REASON_SEARCH =
	"Refused: this lesson has course sources and you have not searched them yet. Search them for the skill first (material_search): " +
	"what the exams ask, the course's definitions and notation. Then call plan_init again and say in `sources` what you found and what the plan uses.";

export const SOURCES_GATE_REASON_SAY =
	"Refused: say in plan_init's `sources` field what the sources showed and what the plan uses from them (one or two sentences, " +
	"cited as (name, p. N); if they do not cover this skill, say what you searched for), then call plan_init again.";

export type SourcesGateProblem = "search" | "say";

/** Has a source lookup succeeded in this conversation? */
function searched(history: readonly unknown[]): boolean {
	return history.some((m) => {
		const r = m as ToolResultMessage;
		return r.role === "toolResult" && !r.isError && SOURCE_TOOLS.includes(r.toolName);
	});
}

/** Did the calling message itself look in the sources before this call? Its results are not in `history` yet. */
function searchedEarlier(message: AssistantMessage | undefined, toolCallId: string | undefined): boolean {
	if (!message || toolCallId === undefined) return false;
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		if (block.id === toolCallId) return false;
		if (SOURCE_TOOLS.includes(block.name)) return true;
	}
	return false;
}

/** Is there an earlier plan_init that went through (a refused one, or one answered `{ok:false}`, wrote no plan)? */
function planned(history: readonly unknown[]): boolean {
	return history.some((m) => {
		const r = m as ToolResultMessage;
		return r.role === "toolResult" && r.toolName === "plan_init" && !r.isError && (r.details as { ok?: unknown } | null | undefined)?.ok !== false;
	});
}

/**
 * Why must this call wait, or null when it may go through? Only `plan_init`, and only when `available` (the tools the
 * tutor has this turn) holds `material_search`. A search must have happened; the FIRST plan must also carry `sources`
 * (a later rewrite of the map does not need it again).
 */
export function sourcesGateProblem(
	history: readonly unknown[],
	toolName: string,
	args: unknown,
	available: readonly string[],
	message?: AssistantMessage,
	toolCallId?: string,
): SourcesGateProblem | null {
	if (toolName !== "plan_init" || !available.includes("material_search")) return null;
	if (!searched(history) && !searchedEarlier(message, toolCallId)) return "search";
	if (planned(history)) return null;
	const sources = (args as { sources?: unknown } | null | undefined)?.sources;
	return typeof sources === "string" && sources.trim() !== "" ? null : "say";
}

export function sourcesGateReason(problem: SourcesGateProblem): string {
	return problem === "search" ? SOURCES_GATE_REASON_SEARCH : SOURCES_GATE_REASON_SAY;
}
