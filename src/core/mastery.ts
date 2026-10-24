/**
 * Known — the Leitner stand-in (fork addition, 2026-10-24; spec:
 * docs/courses.md §2, owner decisions of the same day). PURE, browser-safe.
 *
 * Every skill has a box 0–5, DERIVED by folding the concluded practice
 * problems of course sessions in time order — nothing is stored. A box
 * comes due BOX_INTERVAL_DAYS after its last move; box 0 is always due.
 *
 *   solved, skill due          box + 1 (max 5)
 *   solved, not due            nothing (spacing is the point)
 *   solvedWithHints            nothing
 *   movedOn / surrendered      box 1
 *   dismissed                  ignored
 *   placement: solved          box ≥ 3, and every transitive prerequisite ≥ 3
 *   placement: with hints      box ≥ 1
 *   placement: moved on / gave up   box 1
 *
 * Known = box ≥ KNOWN_BOX. An overdue skill stays known until a review
 * is missed.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ChatCourseLink, Skill } from "./contracts/course.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMarkerMessage, type LhMessage } from "./native-messages.ts";
import { prerequisiteClosure, topoOrder } from "./skills.ts";

/** Days until a box comes due, by box (box 0 is always due). */
export const BOX_INTERVAL_DAYS = [0, 1, 3, 7, 16, 35] as const;
export const MAX_BOX = 5;
export const KNOWN_BOX = 3;
const DAY_MS = 86_400_000;

export type ProblemOutcome = "solved" | "solvedWithHints" | "movedOn" | "surrendered" | "dismissed";

/** One concluded problem's verdict on one skill. */
export interface SkillEvent {
	skillId: string;
	/** ms — the conclude's timestamp. */
	at: number;
	outcome: ProblemOutcome;
	placement: boolean;
}

export interface BoxState {
	box: number;
	/** ms of the last box move; null = never moved. */
	lastMove: number | null;
}

const OUTCOMES = new Set<string>(["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"]);

/** The skill events of ONE course practice session: every cleanly
 *  concluded problem that carried `skills`. Learn sessions have none. */
export function skillEventsOf(messages: readonly LhMessage[], link: ChatCourseLink): SkillEvent[] {
	if (link.mode === "learn") return [];
	const clean = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult" && !(m as ToolResultMessage).isError) {
			clean.add((m as ToolResultMessage).toolCallId);
		}
	}
	const events: SkillEvent[] = [];
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
	const sorted = [...events].sort((a, b) => a.at - b.at);
	for (const event of sorted) {
		if (event.outcome === "dismissed") continue;
		const state = get(event.skillId);
		const missed = event.outcome === "movedOn" || event.outcome === "surrendered";
		if (missed) {
			state.box = 1;
			state.lastMove = event.at;
			continue;
		}
		if (event.placement) {
			if (event.outcome === "solved") {
				for (const id of [event.skillId, ...prerequisiteClosure(event.skillId, requiresOf)]) {
					const s = get(id);
					s.box = Math.max(s.box, KNOWN_BOX);
					s.lastMove = event.at;
				}
			} else if (state.box < 1) {
				state.box = 1;
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
	/** Not known, every prerequisite known. */
	nextUp: string[];
	/** Not known, some prerequisite unknown. */
	locked: string[];
	known: string[];
	/** Per skill: its state, and its prerequisites not known yet. */
	states: Map<string, { state: BoxState; known: boolean; due: boolean; missing: string[] }>;
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
	const isKnown = (id: string) => stateOf(id).box >= KNOWN_BOX;
	const out: SkillPartition = { order, review: [], nextUp: [], locked: [], known: [], states: new Map() };
	for (const id of order) {
		const state = stateOf(id);
		const known = state.box >= KNOWN_BOX;
		const due = isDue(state, now);
		const missing = requiresOf(id).filter((req) => skillsById.has(req) && !isKnown(req));
		out.states.set(id, { state, known, due, missing });
		if (state.box >= 1 && due) out.review.push(id);
		if (known) out.known.push(id);
		else if (missing.length === 0) out.nextUp.push(id);
		else out.locked.push(id);
	}
	return out;
}
