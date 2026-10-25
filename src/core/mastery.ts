/**
 * Known — the Leitner stand-in (fork addition, 2026-10-24; spec:
 * docs/courses.md §2, owner decisions of 2026-10-24 and 2026-10-25). PURE,
 * browser-safe.
 *
 * Every skill has a box 0–5, DERIVED by folding the course sessions'
 * evidence in time order — nothing is stored. A box comes due
 * BOX_INTERVAL_DAYS after its last move; box 0 is always due.
 *
 *   Learn session finished      box ≥ 1 (learned)
 *   practice: solved, due       box + 1 (max 5)
 *   practice: solved, not due   nothing (spacing is the point)
 *   practice: solvedWithHints   nothing
 *   practice: movedOn/surrendered   box 1 — but a skill at box 0 stays
 *                               there: a miss never counts as learned
 *   dismissed                   ignored
 *   placement test (quiz):
 *     correct, confidence ≥ 70  box ≥ 3, and every transitive prerequisite ≥ 3
 *     correct, less sure        box ≥ 1
 *     wrong / "I don't know"    nothing (never lowers, never counts as learned)
 *   legacy placement check (problems, before 2026-10-25):
 *     solved ≥ 3 + prerequisites · with hints ≥ 1 · moved on / gave up nothing
 *
 * Learned = box ≥ 1 — what unlocks the skills that build on it. Known =
 * box ≥ KNOWN_BOX — the course's progress number. An overdue skill stays
 * known until a review is missed.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ChatCourseLink, Skill } from "./contracts/course.ts";
import type { QuestionAnswerData } from "./question-core.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMarkerMessage, type LhMessage } from "./native-messages.ts";
import { PLACEMENT_KNOWN_CONFIDENCE, lessonFinishOf } from "./course-session.ts";
import { prerequisiteClosure, topoOrder } from "./skills.ts";

/** Days until a box comes due, by box (box 0 is always due). */
export const BOX_INTERVAL_DAYS = [0, 1, 3, 7, 16, 35] as const;
export const MAX_BOX = 5;
export const KNOWN_BOX = 3;
/** Learned = box ≥ LEARNED_BOX: a finished lesson, or any credit. */
export const LEARNED_BOX = 1;
const DAY_MS = 86_400_000;

export type ProblemOutcome = "solved" | "solvedWithHints" | "movedOn" | "surrendered" | "dismissed";

/** The non-problem evidence: a finished Learn session, and the placement
 *  test's three grades. */
export type SkillOutcome = ProblemOutcome | "finished" | "placementKnown" | "placementUnsure" | "placementMiss";

/** One piece of evidence on one skill. */
export interface SkillEvent {
	skillId: string;
	/** ms — the evidence's timestamp. */
	at: number;
	outcome: SkillOutcome;
	/** A legacy placement-check PROBLEM (the outcome is a ProblemOutcome). */
	placement: boolean;
}

export interface BoxState {
	box: number;
	/** ms of the last box move; null = never moved. */
	lastMove: number | null;
}

const OUTCOMES = new Set<string>(["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"]);

/** The placement test's grade of one answer (pure — the fold's input). */
export function placementGrade(answer: Pick<QuestionAnswerData, "dontKnow" | "correct" | "confidence">): "placementKnown" | "placementUnsure" | "placementMiss" {
	if (answer.dontKnow || answer.correct !== true) return "placementMiss";
	return (answer.confidence ?? 0) >= PLACEMENT_KNOWN_CONFIDENCE ? "placementKnown" : "placementUnsure";
}

/** The skill events of ONE course session:
 *  - Learn: its finish (lessonFinishOf), once, on the session's skill.
 *  - placement: every answered placement `probe` that carried `skill`
 *    (plus a legacy placement check's concluded problems).
 *  - practice/review: every cleanly concluded problem that carried
 *    `skills`. */
export function skillEventsOf(messages: readonly LhMessage[], link: ChatCourseLink): SkillEvent[] {
	if (link.mode === "learn") {
		const finish = lessonFinishOf(messages);
		return finish ? link.skillIds.map((skillId) => ({ skillId, at: finish.at, outcome: "finished" as const, placement: false })) : [];
	}
	const clean = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult" && !(m as ToolResultMessage).isError) {
			clean.add((m as ToolResultMessage).toolCallId);
		}
	}
	const events: SkillEvent[] = [];
	if (link.mode === "placement") {
		// the placement test: probe calls tagged with one skill, graded by
		// the learner's answer (its toolResult details — QuestionAnswerData)
		const skillOf = new Map<string, string>();
		for (const m of messages) {
			if ((m as { role?: string }).role !== "assistant") continue;
			for (const block of (m as AssistantMessage).content) {
				if (block.type !== "toolCall" || block.name !== "probe") continue;
				const skill = (block.arguments as { skill?: unknown } | undefined)?.skill;
				if (typeof skill === "string") skillOf.set(block.id, skill);
			}
		}
		for (const m of messages) {
			if ((m as { role?: string }).role !== "toolResult") continue;
			const result = m as ToolResultMessage;
			const skillId = skillOf.get(result.toolCallId);
			const answer = result.details as QuestionAnswerData | undefined;
			if (!skillId || result.isError || !answer || typeof answer !== "object" || answer.dismissed) continue;
			events.push({ skillId, at: result.timestamp, outcome: placementGrade(answer), placement: false });
		}
	}
	let active: string[] | null = null;
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "custom" && (m as LhMarkerMessage).customType === "problem-dismissed") {
			active = null;
			continue;
		}
		if (role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		for (const block of assistant.content) {
			if (block.type !== "toolCall" || !clean.has(block.id)) continue;
			if (block.name === PRACTICE_PROBLEM_TOOL) {
				const skills = (block.arguments as { skills?: unknown } | undefined)?.skills;
				active = Array.isArray(skills) ? skills.filter((s): s is string => typeof s === "string") : [];
			} else if (block.name === PRACTICE_CONCLUDE_TOOL) {
				const outcome = (block.arguments as { outcome?: unknown } | undefined)?.outcome;
				if (active && typeof outcome === "string" && OUTCOMES.has(outcome)) {
					for (const skillId of new Set(active)) {
						events.push({ skillId, at: assistant.timestamp, outcome: outcome as ProblemOutcome, placement: link.mode === "placement" });
					}
				}
				active = null;
			}
		}
	}
	return events;
}

/** Is a skill in this state due at `now` (ms)? */
export function isDue(state: BoxState, now: number): boolean {
	if (state.box === 0 || state.lastMove === null) return true;
	return now >= state.lastMove + BOX_INTERVAL_DAYS[Math.min(state.box, MAX_BOX)]! * DAY_MS;
}

/** When a skill next comes due (ms); null at box 0 (always due). */
export function dueAt(state: BoxState): number | null {
	if (state.box === 0 || state.lastMove === null) return null;
	return state.lastMove + BOX_INTERVAL_DAYS[Math.min(state.box, MAX_BOX)]! * DAY_MS;
}

/** Fold every skill event (any order — sorted here) into box states.
 *  Skills without events are absent (= box 0). */
export function foldBoxes(events: readonly SkillEvent[], requiresOf: (id: string) => readonly string[]): Map<string, BoxState> {
	const boxes = new Map<string, BoxState>();
	const get = (id: string): BoxState => {
		let state = boxes.get(id);
		if (!state) {
			state = { box: 0, lastMove: null };
			boxes.set(id, state);
		}
		return state;
	};
	/** Lift a box to at least `box` (a lift is a move; no lift, no move). */
	const raise = (state: BoxState, box: number, at: number) => {
		if (state.box >= box) return;
		state.box = box;
		state.lastMove = at;
	};
	/** A clean placement credit: the skill and every transitive
	 *  prerequisite to KNOWN — fresh evidence, so each one's clock restarts. */
	const credit = (skillId: string, at: number) => {
		for (const id of [skillId, ...prerequisiteClosure(skillId, requiresOf)]) {
			const s = get(id);
			s.box = Math.max(s.box, KNOWN_BOX);
			s.lastMove = at;
		}
	};
	const sorted = [...events].sort((a, b) => a.at - b.at);
	for (const event of sorted) {
		if (event.outcome === "dismissed" || event.outcome === "placementMiss") continue;
		const state = get(event.skillId);
		if (event.outcome === "finished" || event.outcome === "placementUnsure") {
			raise(state, LEARNED_BOX, event.at);
			continue;
		}
		if (event.outcome === "placementKnown") {
			credit(event.skillId, event.at);
			continue;
		}
		const missed = event.outcome === "movedOn" || event.outcome === "surrendered";
		if (event.placement) {
			// the legacy placement check (problems): never lowers, and a miss
			// never counts as learned
			if (event.outcome === "solved") credit(event.skillId, event.at);
			else if (!missed) raise(state, LEARNED_BOX, event.at);
			continue;
		}
		if (missed) {
			// back to box 1 — but a skill never learned stays unlearned: a
			// miss must not unlock what builds on it
			if (state.box >= LEARNED_BOX) {
				state.box = LEARNED_BOX;
				state.lastMove = event.at;
			}
			continue;
		}
		if (event.outcome === "solved" && isDue(state, event.at)) {
			state.box = Math.min(MAX_BOX, state.box + 1);
			state.lastMove = event.at;
		}
	}
	return boxes;
}

/** A course's skills, partitioned for the route (docs/courses.md §2). */
export interface SkillPartition {
	/** Topological order (prerequisites first) of every course skill. */
	order: string[];
	/** box ≥ 1 and due. */
	review: string[];
	/** Not learned (box 0), every prerequisite learned — what to learn next. */
	nextUp: string[];
	/** Learned, not known yet (box 1–2) — what to practice. */
	learning: string[];
	/** Not learned, some prerequisite not learned. */
	locked: string[];
	known: string[];
	/** Per skill: its state, and its prerequisites not learned yet. */
	states: Map<string, { state: BoxState; learned: boolean; known: boolean; due: boolean; missing: string[] }>;
}

export function partitionSkills(
	courseSkillIds: readonly string[],
	skillsById: ReadonlyMap<string, Skill>,
	boxes: ReadonlyMap<string, BoxState>,
	now: number,
): SkillPartition {
	const ids = courseSkillIds.filter((id) => skillsById.has(id));
	const requiresOf = (id: string) => skillsById.get(id)?.requires ?? [];
	const order = topoOrder(ids, requiresOf) ?? ids;
	const stateOf = (id: string): BoxState => boxes.get(id) ?? { box: 0, lastMove: null };
	const isLearned = (id: string) => stateOf(id).box >= LEARNED_BOX;
	const out: SkillPartition = { order, review: [], nextUp: [], learning: [], locked: [], known: [], states: new Map() };
	for (const id of order) {
		const state = stateOf(id);
		const learned = state.box >= LEARNED_BOX;
		const known = state.box >= KNOWN_BOX;
		const due = isDue(state, now);
		const missing = requiresOf(id).filter((req) => skillsById.has(req) && !isLearned(req));
		out.states.set(id, { state, learned, known, due, missing });
		if (learned && due) out.review.push(id);
		if (known) out.known.push(id);
		else if (learned) out.learning.push(id);
		else if (missing.length === 0) out.nextUp.push(id);
		else out.locked.push(id);
	}
	return out;
}
