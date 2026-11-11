import type { LhMessage } from "./native-messages.ts";
import { PRACTICE_CONCLUDE_TOOL } from "./native-messages.ts";
import type { PlanTree } from "./contracts.ts";
import type { DerivedPlanStatuses } from "./contracts/plan.ts";
import { placementQuestionTarget } from "./course-session.ts";

/** 0–1, clamped; 0 = nothing done yet (the bar then stays hidden). */
const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Depth of every node: the longest path (in edges) from any root to it. Cycles cannot occur (the tree is a DAG). */
function layersOf(tree: PlanTree): Map<string, number> {
	const incoming = new Map<string, string[]>();
	for (const e of tree.edges) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
	const memo = new Map<string, number>();
	const depth = (id: string, seen: ReadonlySet<string>): number => {
		const known = memo.get(id);
		if (known !== undefined) return known;
		if (seen.has(id)) return 0;
		const next = new Set(seen).add(id);
		const d = Math.max(-1, ...(incoming.get(id) ?? []).map((p) => depth(p, next))) + 1;
		memo.set(id, d);
		return d;
	};
	for (const n of tree.nodes) depth(n.id, new Set());
	return memo;
}

/** Learn: vertical travel down the plan — (deepest layer reached + 1) / layer count, where "reached" is the
 *  current or any visited node. Parallel boxes share a layer, so skipping a sibling costs nothing. 1 once the lesson is finished. */
export function learnProgress(tree: PlanTree | null, statuses: DerivedPlanStatuses | null, finished: boolean): number {
	if (finished) return 1;
	if (!tree || !statuses || tree.nodes.length === 0) return 0;
	const layers = layersOf(tree);
	const total = Math.max(...layers.values()) + 1;
	const reached = [statuses.current, ...statuses.visited].filter((id): id is string => id !== null).map((id) => layers.get(id));
	const deepest = Math.max(-1, ...reached.filter((d): d is number => d !== undefined));
	return deepest < 0 ? 0 : clamp01((deepest + 1) / total);
}

/** Problems concluded in a practice-style session: every clean conclude except the synthesized `dismissed`. */
export function concludedProblemCount(messages: readonly LhMessage[]): number {
	const clean = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult" && !(m as { isError?: boolean }).isError) clean.add((m as { toolCallId: string }).toolCallId);
	}
	let n = 0;
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		for (const block of (m as { content: Array<{ type: string; id?: string; name?: string; arguments?: { outcome?: unknown } }> }).content) {
			if (block.type === "toolCall" && block.name === PRACTICE_CONCLUDE_TOOL && block.id && clean.has(block.id) && block.arguments?.outcome !== "dismissed") n++;
		}
	}
	return n;
}

/** Placement: answered probe questions (right, wrong or "don't know"; not dismissed) — quiz answer results, as the learner fold reads them. */
export function answeredQuestionCount(messages: readonly LhMessage[]): number {
	let n = 0;
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const r = m as { isError?: boolean; details?: { kind?: string; dismissed?: boolean } | null };
		if (!r.isError && r.details && typeof r.details === "object" && r.details.kind === "quiz" && !r.details.dismissed) n++;
	}
	return n;
}

/** The session bar's fill (0–1) for a course session, or null when the mode has none. */
export function sessionProgress(
	mode: "learn" | "practice" | "review" | "placement" | "check",
	input: { messages: readonly LhMessage[]; skillCount: number; tree: PlanTree | null; statuses: DerivedPlanStatuses | null; finished: boolean },
): number {
	if (mode === "learn") return learnProgress(input.tree, input.statuses, input.finished);
	if (mode === "placement") return clamp01(answeredQuestionCount(input.messages) / placementQuestionTarget(input.skillCount));
	return clamp01(concludedProblemCount(input.messages) / Math.max(1, input.skillCount));
}
