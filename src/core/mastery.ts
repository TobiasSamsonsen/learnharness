/**
 * Understanding — what the learner knows, per skill (fork addition,
 * 2026-11-07; replaces the Leitner boxes of 2026-10-24/25; spec:
 * docs/courses.md §2). PURE, browser-safe.
 *
 * Every skill has an FSRS-6 memory state (difficulty, stability) DERIVED by
 * folding the course sessions' evidence in time order — nothing is stored.
 * See https://github.com/open-spaced-repetition/awesome-fsrs/wiki/ABC-of-FSRS:
 *
 *   stability S      days for recall to fall from 100% to 90%
 *   retrievability R chance of recall NOW: R(t, S), falling as days pass
 *   difficulty D     how fast S grows after a review (1–10)
 *
 * Each piece of evidence is ONE review with an Anki grade, again < hard <
 * good < easy. A separate GRADER model grades a problem skill by skill from
 * its whole transcript (agent/practice-grade.ts; the grades ride the conclude
 * RESULT's details: what the learner demonstrated, never more); records from
 * before it carry the tutor's own conclude `grades`; with neither, the
 * outcome gives the default grade.
 *
 *   Learn session finished        good
 *   placement test, correct, ≥ 70 the skill easy AND seeded to
 *                                 PLACEMENT_SEED_DAYS of stability (known at
 *                                 once, owner 2026-11-07); every transitive
 *                                 prerequisite good, seeded to PREREQUISITE_SEED_DAYS
 *                                 — except one missed directly
 *   placement test, correct, less sure   hard
 *   placement test, wrong / "I don't know"   nothing, and blocks inferred
 *                                 credit, in any order
 *   practice outcome, no grades   solved good · solvedWithHints hard ·
 *                                 movedOn/surrendered/taught again
 *   dismissed                     ignored
 *   an `again` on a skill never learned: ignored — a miss never counts
 *                                 as learned
 *   legacy placement check (problems, before 2026-10-25):
 *     solved credits like placementKnown · with hints hard · missed nothing
 *
 * Understanding (0–10, what the learner SEES) = how long the skill lasts:
 * ln(1+S)/ln(1+365)×10 — a year of stability is 10. It does not fall as the
 * days pass. Whether a skill NEEDS REVIEW is the standard FSRS question:
 * retrievability now below DESIRED_RETENTION (90%). Learned = has a state:
 * what unlocks the skills that build on it. Known = understanding ≥
 * KNOWN_UNDERSTANDING, about a month of memory.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ChatCourseLink, Skill } from "./contracts/course.ts";
import type { QuestionAnswerData } from "./question-core.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMarkerMessage, type LhMessage } from "./native-messages.ts";
import { PLACEMENT_KNOWN_CONFIDENCE, sessionFinishOf } from "./course-session.ts";
import { FSRS6Algorithm, FSRS6_DEFAULT_WEIGHTS, FSRS6_MODEL_BOUNDS } from "ts-fsrs/models/fsrs-6";
import { prerequisiteClosure, topoOrder } from "./skills.ts";

/** FSRS's target: a skill needs review once recall falls below this. */
export const DESIRED_RETENTION = 0.9;
/** Understanding at or above this is "known" — a stability of about a month. */
export const KNOWN_UNDERSTANDING = 6;
export const MAX_UNDERSTANDING = 10;
/** A stability of this many days is understanding 10. */
const UNDERSTANDING_FULL_DAYS = 365;
const DAY_MS = 86_400_000;
/** A confident placement answer seeds the skill's stability to at least this
 *  many days (understanding ≈ 6.3: known), then FSRS runs normally. */
export const PLACEMENT_SEED_DAYS = 40;
/** …and an inferred prerequisite to this many (≈ 5.2: learning — one answer
 *  proves less about what lies under it). */
export const PREREQUISITE_SEED_DAYS = 20;

/** The Anki scale, least to most learned. */
export type Grade = "again" | "hard" | "good" | "easy";
export const GRADES: readonly Grade[] = ["again", "hard", "good", "easy"];
const GRADE_NUMBER: Record<Grade, 1 | 2 | 3 | 4> = { again: 1, hard: 2, good: 3, easy: 4 };

export type ProblemOutcome = "solved" | "solvedWithHints" | "movedOn" | "surrendered" | "taught" | "dismissed";

/** The non-problem evidence: a finished Learn session, and the placement
 *  test's three grades. */
export type SkillOutcome = ProblemOutcome | "finished" | "placementKnown" | "placementUnsure" | "placementMiss";

/** One piece of evidence on one skill. */
export interface SkillEvent {
	skillId: string;
	/** ms — the evidence's timestamp. */
	at: number;
	outcome: SkillOutcome;
	/** The tutor's grade for this skill on this problem; absent = the
	 *  outcome's default. */
	grade?: Grade;
	/** A legacy placement-check PROBLEM (the outcome is a ProblemOutcome). */
	placement: boolean;
}

/** A learned skill's FSRS memory state. A skill without evidence has none. */
export interface SkillState {
	/** days for recall to fall to 90% */
	stability: number;
	/** 1–10 */
	difficulty: number;
	/** ms of the last review. */
	lastReview: number;
}

const OUTCOMES = new Set<string>(["solved", "solvedWithHints", "movedOn", "surrendered", "taught", "dismissed"]);
const GRADE_SET = new Set<string>(GRADES);

const algorithm = new FSRS6Algorithm([...FSRS6_DEFAULT_WEIGHTS], false, FSRS6_MODEL_BOUNDS);

/** The grade an outcome stands for when the tutor gave none; null = no review. */
export function defaultGrade(outcome: SkillOutcome): Grade | null {
	switch (outcome) {
		case "finished":
		case "solved":
			return "good";
		case "placementKnown":
			return "easy";
		case "solvedWithHints":
		case "placementUnsure":
			return "hard";
		case "movedOn":
		case "surrendered":
		case "taught":
			return "again";
		default:
			return null;
	}
}

/** Chance of recall at `now` (ms): 1 right after a review, 0.9 one stability later. */
export function retrievability(state: SkillState, now: number): number {
	return algorithm.forgetting_curve(Math.max(0, (now - state.lastReview) / DAY_MS), state.stability);
}

/** Does this skill need review at `now`? FSRS: retrievability below the target. */
export function needsReview(state: SkillState, now: number): boolean {
	return retrievability(state, now) < DESIRED_RETENTION;
}

/** When retrievability reaches the target (ms) — a stability after the last review. */
export function reviewAt(state: SkillState): number {
	return state.lastReview + state.stability * DAY_MS;
}

/** 0–10: how long the skill lasts (see the file header). Rounded to a tenth. */
export function understandingOf(state: SkillState): number {
	const raw = (Math.log(1 + state.stability) / Math.log(1 + UNDERSTANDING_FULL_DAYS)) * MAX_UNDERSTANDING;
	return Math.round(Math.min(MAX_UNDERSTANDING, raw) * 10) / 10;
}

export const isKnown = (state: SkillState): boolean => understandingOf(state) >= KNOWN_UNDERSTANDING;

/** How much of "known" a skill is, 0–1: its understanding over the known line,
 *  capped, so a known skill is 1 and the 0–10 scale's depth above the line does
 *  not count toward coverage (owner, 2026-11-08). */
export function knownShare(understanding: number): number {
	return Math.min(1, Math.max(0, understanding / KNOWN_UNDERSTANDING));
}

/** A course's progress, 0–100: the average known share of its skills
 *  (a skill with no evidence counts 0). Smooth where "known" is a cliff. */
export function courseProgressPercent(understandings: readonly number[]): number {
	if (understandings.length === 0) return 0;
	const mean = understandings.reduce((sum, u) => sum + knownShare(u), 0) / understandings.length;
	return Math.round(mean * 100);
}

/** What an understanding means in time: about how long the skill is
 *  remembered (the stability it was computed from, inverted). */
export function lastsLabel(understanding: number): string {
	const days = Math.round(Math.exp((understanding / MAX_UNDERSTANDING) * Math.log(1 + UNDERSTANDING_FULL_DAYS)) - 1);
	if (days < 2) return "about a day";
	if (days < 14) return `about ${days} days`;
	if (days < 60) return `about ${Math.round(days / 7)} weeks`;
	if (days < 365) return `about ${Math.round(days / 30)} months`;
	return "about a year";
}

/** The placement test's grade of one answer (pure — the fold's input). */
export function placementGrade(answer: Pick<QuestionAnswerData, "dontKnow" | "correct" | "confidence">): "placementKnown" | "placementUnsure" | "placementMiss" {
	if (answer.dontKnow || answer.correct !== true) return "placementMiss";
	return (answer.confidence ?? 0) >= PLACEMENT_KNOWN_CONFIDENCE ? "placementKnown" : "placementUnsure";
}

/** The tutor's per-skill grades off a `conclude` call's arguments: the
 *  well-formed `{ skill, grade }` entries (a later entry for a skill wins). */
export function gradesOf(raw: unknown): Map<string, Grade> {
	const out = new Map<string, Grade>();
	if (!Array.isArray(raw)) return out;
	for (const entry of raw) {
		const { skill, grade } = (entry ?? {}) as { skill?: unknown; grade?: unknown };
		if (typeof skill === "string" && typeof grade === "string" && GRADE_SET.has(grade)) out.set(skill, grade as Grade);
	}
	return out;
}

/** The per-skill grades of one concluded problem. A conclude RESULT whose details carry `grades` is the practice
 *  grader's verdict (agent/practice-grade.ts; an empty list = the grader failed or skipped a skill, so the
 *  outcome's default applies, and a tutor's stray `grades` argument is never consulted). Records from before the
 *  grader (details null) fall back to the tutor's own `grades` argument. */
export function concludeGradesOf(args: { grades?: unknown } | undefined, details: unknown): Map<string, Grade> {
	if (details && typeof details === "object" && Array.isArray((details as { grades?: unknown }).grades)) return gradesOf((details as { grades: unknown }).grades);
	return gradesOf(args?.grades);
}

/** The skill events of ONE course session:
 *  - Learn: its finish (sessionFinishOf), once, on the session's skill.
 *  - placement: every answered placement `probe` that carried `skill`
 *    (plus a legacy placement check's concluded problems).
 *  - practice/review: every cleanly concluded problem that carried
 *    `skills`. */
export function skillEventsOf(messages: readonly LhMessage[], link: ChatCourseLink): SkillEvent[] {
	if (link.mode === "learn") {
		const finish = sessionFinishOf(messages);
		return finish ? link.skillIds.map((skillId) => ({ skillId, at: finish.at, outcome: "finished" as const, placement: false })) : [];
	}
	const clean = new Set<string>();
	const detailsOf = new Map<string, unknown>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult" && !(m as ToolResultMessage).isError) {
			clean.add((m as ToolResultMessage).toolCallId);
			detailsOf.set((m as ToolResultMessage).toolCallId, (m as ToolResultMessage).details);
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
				const args = block.arguments as { outcome?: unknown; grades?: unknown } | undefined;
				const outcome = args?.outcome;
				if (active && typeof outcome === "string" && OUTCOMES.has(outcome)) {
					const graded = concludeGradesOf(args, detailsOf.get(block.id));
					for (const skillId of new Set(active)) {
						const grade = graded.get(skillId);
						events.push({ skillId, at: assistant.timestamp, outcome: outcome as ProblemOutcome, ...(grade ? { grade } : {}), placement: link.mode === "placement" });
					}
				}
				active = null;
			}
		}
	}
	return events;
}

/** Fold every skill event (any order — sorted here) into memory states.
 *  Skills without evidence are absent (= not learned). */
export function foldSkills(events: readonly SkillEvent[], requiresOf: (id: string) => readonly string[]): Map<string, SkillState> {
	const states = new Map<string, SkillState>();
	/** One review of `skillId` with `grade` at `at` (ms). An `again` on a
	 *  skill never learned is no review: a miss must not unlock what builds
	 *  on it. */
	const review = (skillId: string, grade: Grade, at: number) => {
		const state = states.get(skillId);
		if (!state && grade === "again") return;
		const elapsedDays = state ? Math.max(0, (at - state.lastReview) / DAY_MS) : 0;
		const next = algorithm.next_state(state ? { stability: state.stability, difficulty: state.difficulty } : null, elapsedDays, GRADE_NUMBER[grade]);
		states.set(skillId, { stability: next.stability, difficulty: next.difficulty, lastReview: at });
	};
	/** Direct evidence beats inference (owner, 2026-10-25 — the ITGK
	 *  placement): a prerequisite the learner missed directly is never
	 *  credited through a skill above it, whichever came first. */
	const missedDirectly = new Set(events.filter((e) => e.outcome === "placementMiss").map((e) => e.skillId));
	/** Raise a learned skill's stability to at least `days` (never lowers). */
	const seed = (skillId: string, days: number) => {
		const state = states.get(skillId);
		if (state && state.stability < days) state.stability = days;
	};
	/** A clean placement credit: the skill itself `easy` and seeded known, every
	 *  transitive prerequisite `good` and seeded lower (inferred, so weaker
	 *  evidence). */
	const credit = (skillId: string, at: number) => {
		review(skillId, "easy", at);
		seed(skillId, PLACEMENT_SEED_DAYS);
		for (const id of prerequisiteClosure(skillId, requiresOf)) {
			if (id === skillId || missedDirectly.has(id)) continue;
			review(id, "good", at);
			seed(id, PREREQUISITE_SEED_DAYS);
		}
	};
	const sorted = [...events].sort((a, b) => a.at - b.at);
	for (const event of sorted) {
		if (event.outcome === "dismissed" || event.outcome === "placementMiss") continue;
		if (event.outcome === "placementKnown") {
			credit(event.skillId, event.at);
			continue;
		}
		const grade = event.grade ?? defaultGrade(event.outcome);
		if (!grade) continue;
		if (event.placement) {
			// the legacy placement check (problems): a clean solve credits like a
			// confident placement answer; a miss is nothing
			if (event.outcome === "solved") credit(event.skillId, event.at);
			else if (grade !== "again") review(event.skillId, grade, event.at);
			continue;
		}
		review(event.skillId, grade, event.at);
	}
	return states;
}

/** The skills one course has evidence on: anything its own sessions
 *  learned (inferred placement credit included — a fold of the course's
 *  events alone) and anything they touched at all (a concluded check, a
 *  placement miss). Dismissals do not count. */
export function inCourseEvidence(courseEvents: readonly SkillEvent[], requiresOf: (id: string) => readonly string[]): Set<string> {
	const out = new Set(courseEvents.filter((e) => e.outcome !== "dismissed").map((e) => e.skillId));
	for (const id of foldSkills(courseEvents, requiresOf).keys()) out.add(id);
	return out;
}

/** A review session's size: 4 weakest + 1 stalest + 1 morale (owner, 2026-11-07). */
export const REVIEW_SESSION_SIZE = 6;
const REVIEW_WEAKEST = 4;

/** The skills of ONE review session, in the order they are posed, out of
 *  everything that needs review (`partition.review`):
 *  - the WEAKEST four: lowest understanding first;
 *  - the STALEST one: not practiced for the longest of what is left;
 *  - one MORALE skill: the highest understanding of what is left, so the
 *    session has something the learner can do;
 *  and with `size` or fewer to review, all of them. Posed morale first (the
 *  doctrine's warm open), then weakest to strongest. What is not picked stays
 *  due: the queue works through the skills over several sessions. */
export function pickReviewSkills(p: Pick<SkillPartition, "review" | "states">, size = REVIEW_SESSION_SIZE): string[] {
	const info = (id: string) => {
		const state = p.states.get(id)?.state;
		return { id, understanding: state ? understandingOf(state) : 0, lastReview: state?.lastReview ?? 0 };
	};
	const pool = p.review.map(info);
	const byWeakness = (a: ReturnType<typeof info>, b: ReturnType<typeof info>) => a.understanding - b.understanding || a.lastReview - b.lastReview || a.id.localeCompare(b.id);
	const picked: ReturnType<typeof info>[] = [];
	const take = (candidates: ReturnType<typeof info>[]) => {
		const next = candidates.find((c) => !picked.includes(c));
		if (next) picked.push(next);
	};
	const weakest = [...pool].sort(byWeakness);
	if (pool.length > size) {
		for (let i = 0; i < Math.min(REVIEW_WEAKEST, size); i++) take(weakest);
		take([...pool].sort((a, b) => a.lastReview - b.lastReview || byWeakness(a, b))); // stalest
		take([...pool].sort((a, b) => b.understanding - a.understanding || byWeakness(a, b))); // morale
	} else picked.push(...pool);
	const ordered = [...picked].sort(byWeakness);
	// morale first: the strongest of the pick
	const morale = ordered[ordered.length - 1];
	return morale ? [morale.id, ...ordered.slice(0, -1).map((c) => c.id)] : [];
}

/** A course's skills, partitioned for the route (docs/courses.md §2). */
export interface SkillPartition {
	/** Topological order (prerequisites first) of every course skill. */
	order: string[];
	/** Learned and needing review now. */
	review: string[];
	/** Not learned, every prerequisite learned — what to learn next. */
	nextUp: string[];
	/** Learned, not known yet (understanding below KNOWN_UNDERSTANDING) — what to practice. */
	learning: string[];
	/** Not learned, some prerequisite not learned. */
	locked: string[];
	known: string[];
	/** Learned on evidence from OTHER courses only — the context check's
	 *  offer (owner, 2026-10-25). Also listed in known/learning. */
	contextCheck: string[];
	/** Per skill: its state (null = not learned), and its prerequisites not learned yet. */
	states: Map<string, { state: SkillState | null; learned: boolean; known: boolean; needsReview: boolean; missing: string[] }>;
}

export function partitionSkills(
	courseSkillIds: readonly string[],
	skillsById: ReadonlyMap<string, Skill>,
	skillStates: ReadonlyMap<string, SkillState>,
	now: number,
	/** The skills THIS course has evidence on (inCourseEvidence); absent =
	 *  no context checks. */
	inCourse?: ReadonlySet<string>,
): SkillPartition {
	const ids = courseSkillIds.filter((id) => skillsById.has(id));
	const requiresOf = (id: string) => skillsById.get(id)?.requires ?? [];
	const order = topoOrder(ids, requiresOf) ?? ids;
	const out: SkillPartition = { order, review: [], nextUp: [], learning: [], locked: [], known: [], contextCheck: [], states: new Map() };
	for (const id of order) {
		const state = skillStates.get(id) ?? null;
		const learned = state !== null;
		const known = state !== null && isKnown(state);
		const due = state !== null && needsReview(state, now);
		const missing = requiresOf(id).filter((req) => skillsById.has(req) && !skillStates.has(req));
		out.states.set(id, { state, learned, known, needsReview: due, missing });
		if (learned && due) out.review.push(id);
		if (learned && inCourse && !inCourse.has(id)) out.contextCheck.push(id);
		if (known) out.known.push(id);
		else if (learned) out.learning.push(id);
		else if (missing.length === 0) out.nextUp.push(id);
		else out.locked.push(id);
	}
	return out;
}
