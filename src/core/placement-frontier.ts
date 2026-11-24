/**
 * Placement frontier & live progress (fork addition, 2026-11-24). PURE, browser-safe.
 *
 * Tracks which course skills have been directly graded (`probe` / `recall`) or
 * transitively credited via `requires` edges, computes the top-down exam-weighted
 * frontier, and detects unread placement sketches.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SkillWeightValue } from "./exam-plan.ts";
import { GRADES, placementGrade, type Grade } from "./mastery.ts";
import type { LhMessage } from "./native-messages.ts";
import type { QuestionAnswerData } from "./question-core.ts";
import { prerequisiteClosure } from "./skills.ts";

export interface PlacementSkillInfo {
	id: string;
	name: string;
	requires: readonly string[];
	priority: SkillWeightValue;
}

export interface PlacementVerdict {
	skill: string;
	grade: Grade;
	gradedBy?: string;
	gradeError?: string;
}

export interface PlacementProgress {
	directGrades: Map<string, Grade>;
	/** Transitive prerequisite skillId -> crediting ancestor skillId. */
	credited: Map<string, string>;
	covered: Set<string>;
	uncoveredWeighted: string[];
	uncoveredZero: string[];
	/** Top-down uncovered sinks: weighted (w >= 1) first, w = 0 once weighted are done. */
	frontier: string[];
	askedCount: number;
	stoppedEarly: boolean;
}

const GRADE_SET = new Set<string>(GRADES);
const PLACEMENT_QUESTION_TOOLS = new Set<string>(["probe", "recall"]);

function validPlacementGrade(raw: unknown): PlacementVerdict | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as { skill?: unknown; grade?: unknown; gradedBy?: unknown; gradeError?: unknown };
	if (typeof r.skill !== "string" || typeof r.grade !== "string" || !GRADE_SET.has(r.grade)) return null;
	return {
		skill: r.skill,
		grade: r.grade as Grade,
		...(typeof r.gradedBy === "string" ? { gradedBy: r.gradedBy } : {}),
		...(typeof r.gradeError === "string" ? { gradeError: r.gradeError } : {}),
	};
}

/**
 * Extract the placement grade for one answered `probe` or `recall` result.
 * Prefers the persisted grader verdict (`details.placementGrade` on the answer
 * or on the matching clean `read_sketch` result after it), falling back to
 * legacy MC / ungraded defaults when absent.
 */
export function placementVerdictOf(
	messages: readonly LhMessage[],
	answerIndex: number,
	skillId: string,
	toolName: string,
	answerResult: ToolResultMessage,
): PlacementVerdict {
	const details = answerResult.details as (QuestionAnswerData & { placementGrade?: unknown }) | undefined;
	const direct = validPlacementGrade(details?.placementGrade);
	if (direct) return direct;

	const sketchId = details?.sketch?.id;
	if (typeof sketchId === "string" && sketchId !== "") {
		let latest: PlacementVerdict | null = null;
		for (let i = answerIndex + 1; i < messages.length; i++) {
			const m = messages[i] as { role?: string };
			if (m.role !== "toolResult") continue;
			const res = m as ToolResultMessage;
			if (res.isError || res.toolName !== "read_sketch") continue;
			const rd = res.details as { sketchId?: unknown; placementGrade?: unknown } | undefined;
			if (rd?.sketchId !== sketchId) continue;
			const fromRead = validPlacementGrade(rd.placementGrade);
			if (fromRead) latest = fromRead;
		}
		if (latest) return latest;
	}

	if (toolName === "probe" && details) {
		const g = placementGrade(details);
		return {
			skill: skillId,
			grade: g === "placementKnown" ? "easy" : g === "placementUnsure" ? "hard" : "again",
		};
	}
	return {
		skill: skillId,
		grade: details?.dontKnow ? "again" : "hard",
	};
}

/** Compute live placement progress and the top-down exam-weighted frontier. */
export function placementProgressOf(messages: readonly LhMessage[], skills: readonly PlacementSkillInfo[]): PlacementProgress {
	const byId = new Map(skills.map((s) => [s.id, s]));
	const requiresOf = (id: string) => byId.get(id)?.requires ?? [];
	const callInfo = new Map<string, { skill: string; toolName: string }>();

	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		for (const block of (m as AssistantMessage).content) {
			if (block.type !== "toolCall" || !PLACEMENT_QUESTION_TOOLS.has(block.name)) continue;
			const skill = (block.arguments as { skill?: unknown } | undefined)?.skill;
			if (typeof skill === "string" && byId.has(skill)) {
				callInfo.set(block.id, { skill, toolName: block.name });
			}
		}
	}

	const directGrades = new Map<string, Grade>();
	const missedDirectly = new Set<string>();
	let askedCount = 0;
	let stoppedEarly = false;

	for (let i = 0; i < messages.length; i++) {
		const m = messages[i] as { role?: string };
		if (m.role === "user" && askedCount > 0) {
			const raw = (m as { content?: unknown }).content;
			const txt = typeof raw === "string"
				? raw
				: Array.isArray(raw)
					? raw.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join(" ")
					: "";
			if (/\b(stop|stopp|avslutt|finish|ferdig|nok)\b/i.test(txt)) stoppedEarly = true;
			continue;
		}
		if (m.role !== "toolResult") continue;
		const res = m as ToolResultMessage;
		if (res.isError) continue;

		if (res.toolName === "ask_user_question" && askedCount > 0) {
			const ans = res.details as QuestionAnswerData | undefined;
			const picked = `${ans?.answers?.[0]?.value ?? ""} ${ans?.answers?.[0]?.label ?? ""} ${ans?.other ?? ""} ${ans?.text ?? ""}`;
			if (/\b(stop|stopp|avslutt|finish|ferdig)\b/i.test(picked)) stoppedEarly = true;
			continue;
		}

		const info = callInfo.get(res.toolCallId);
		if (!info) continue;
		const details = res.details as QuestionAnswerData | undefined;
		if (!details || typeof details !== "object" || details.dismissed) continue;

		askedCount++;
		const verdict = placementVerdictOf(messages, i, info.skill, info.toolName, res);
		directGrades.set(verdict.skill, verdict.grade);
		if (verdict.grade === "again") missedDirectly.add(verdict.skill);
	}

	const credited = new Map<string, string>();
	for (const [skillId, grade] of directGrades) {
		if (grade !== "easy" && grade !== "good") continue;
		for (const req of prerequisiteClosure(skillId, requiresOf)) {
			if (req === skillId || missedDirectly.has(req) || directGrades.has(req) || credited.has(req)) continue;
			credited.set(req, skillId);
		}
	}

	const covered = new Set<string>([...directGrades.keys(), ...credited.keys()]);
	const uncovered = skills.filter((s) => !covered.has(s.id));
	const uncoveredSet = new Set(uncovered.map((s) => s.id));
	const uncoveredWeighted = uncovered.filter((s) => s.priority > 0).map((s) => s.id);
	const uncoveredZero = uncovered.filter((s) => s.priority === 0).map((s) => s.id);

	// Uncovered dependents for each uncovered skill
	const hasUncoveredDependent = new Set<string>();
	for (const s of uncovered) {
		for (const req of s.requires) {
			if (uncoveredSet.has(req)) hasUncoveredDependent.add(req);
		}
	}

	const uncoveredPrereqCount = (id: string): number => {
		let count = 0;
		for (const req of prerequisiteClosure(id, requiresOf)) {
			if (uncoveredSet.has(req)) count++;
		}
		return count;
	};

	const indexOf = new Map(skills.map((s, idx) => [s.id, idx]));
	const sinkPool = uncoveredWeighted.length > 0
		? uncovered.filter((s) => s.priority > 0 && !hasUncoveredDependent.has(s.id))
		: uncovered.filter((s) => !hasUncoveredDependent.has(s.id));

	// Fallback if a cycle or cross-weight edge leaves no zero-outdegree node in the weighted slice
	const candidates = sinkPool.length > 0 ? sinkPool : uncoveredWeighted.length > 0 ? uncovered.filter((s) => s.priority > 0) : uncovered;
	const frontier = [...candidates]
		.sort((a, b) => b.priority - a.priority || uncoveredPrereqCount(b.id) - uncoveredPrereqCount(a.id) || (indexOf.get(a.id) ?? 0) - (indexOf.get(b.id) ?? 0))
		.map((s) => s.id);

	return {
		directGrades,
		credited,
		covered,
		uncoveredWeighted,
		uncoveredZero,
		frontier,
		askedCount,
		stoppedEarly,
	};
}

/** Compact live status line injected after each placement answer / sketch read-back. */
export function formatPlacementStatus(progress: PlacementProgress, skills: readonly PlacementSkillInfo[]): string {
	const byId = new Map(skills.map((s) => [s.id, s]));
	const requiresOf = (id: string) => byId.get(id)?.requires ?? [];
	const total = skills.length;
	const coveredCount = progress.covered.size;
	const wRem = progress.uncoveredWeighted.length;
	const zRem = progress.uncoveredZero.length;

	if (wRem === 0 && zRem === 0) {
		return `Placement status: ${progress.askedCount} asked; ${coveredCount}/${total} covered (0 remaining). Every skill is tested or credited — summarize what is solid and where to start, then call finish_session.`;
	}

	const top = progress.frontier.slice(0, 6).map((id) => {
		const s = byId.get(id);
		if (!s) return id;
		const uncoveredPrereqs = [...prerequisiteClosure(id, requiresOf)].filter((r) => !progress.covered.has(r)).length;
		return `${id} (${s.name}, w=${s.priority}, covers ${uncoveredPrereqs} prereq${uncoveredPrereqs === 1 ? "" : "s"})`;
	});

	if (wRem === 0 && zRem > 0) {
		return (
			`Placement status: ${progress.askedCount} asked; ${coveredCount}/${total} covered (0 weighted remaining, ${zRem} unexamined w=0 remaining). ` +
			`All examined (w≥1) skills are covered — ask the learner ONCE via ask_user_question whether to test the ${zRem} w=0 skill(s) or finish now. ` +
			`Remaining w=0 frontier: ${top.join("; ")}.`
		);
	}

	return (
		`Placement status: ${progress.askedCount} asked; ${coveredCount}/${total} covered (${wRem} weighted remaining, ${zRem} w=0 remaining). ` +
		`Top-down frontier (pick next skill here): ${top.join("; ")}.`
	);
}

/**
 * Returns `{ sketchId }` if the latest answered placement `probe`/`recall`
 * carries a sketch that has no subsequent clean `read_sketch` (with doubts === 0).
 */
export function hasUnreadPlacementSketch(messages: readonly LhMessage[]): { sketchId: string } | null {
	const placementCallIds = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		for (const block of (m as AssistantMessage).content) {
			if (block.type === "toolCall" && PLACEMENT_QUESTION_TOOLS.has(block.name)) {
				placementCallIds.add(block.id);
			}
		}
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string };
		if (m.role === "user") return null;
		if (m.role !== "toolResult") continue;
		const res = m as ToolResultMessage;
		if (res.isError || !placementCallIds.has(res.toolCallId)) continue;
		const details = res.details as QuestionAnswerData | undefined;
		if (!details || details.dismissed) return null;
		const sketchId = details.sketch?.id;
		if (typeof sketchId !== "string" || sketchId === "") return null;
		for (let j = i + 1; j < messages.length; j++) {
			const later = messages[j] as { role?: string };
			if (later.role !== "toolResult") continue;
			const r = later as ToolResultMessage;
			if (r.isError || r.toolName !== "read_sketch") continue;
			const rd = r.details as { sketchId?: unknown; doubts?: unknown } | undefined;
			if (rd?.sketchId === sketchId && (typeof rd.doubts !== "number" || rd.doubts === 0)) {
				return null;
			}
		}
		return { sketchId };
	}
	return null;
}
