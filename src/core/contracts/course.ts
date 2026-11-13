/**
 * Course contracts — skills, courses, and the session's course link
 * (fork addition, 2026-10-24; spec: docs/courses.md).
 *
 * A course turns a curriculum into SKILLS: checkable abilities that live
 * in the knowledge graph beside the propositions (data/graph/skills.jsonl
 * — one skill shared by every course that needs it), joined by `requires`
 * edges and linked to the propositions they rest on. How well each skill
 * is known is DERIVED (core/mastery.ts — the Leitner stand-in), never
 * stored. Pure types + tiny pure helpers.
 */

import type { LessonLanguage } from "../language.ts";
import type { Pace } from "../pace.ts";
import type { CoursePlan, SkillWeights } from "../exam-plan.ts";
import type { ExtractionStageUsage } from "./chat.ts";

// ─── Skills (the graph's second node kind) ──────────────────────────────────

/** One skills.jsonl line. The FIRST line for an id defines name/statement/
 *  createdAt; later lines for the same id are LINK-APPENDS whose
 *  `requires`/`restsOn` union in (a second course reusing the skill). */
export interface SkillLine {
	/** "sk_" + random — store-assigned at approval. */
	id: string;
	/** A short handle, like a proposition's name ("Chain rule"). */
	name: string;
	/** The checkable ability, at full precision ("Differentiate a
	 *  composition f(g(x)) with the chain rule"). */
	statement: string;
	/** Skill ids that must be known before this one. */
	requires: string[];
	/** Proposition ids (n_…) this skill rests on — the planner's links. */
	restsOn: string[];
	createdAt: string;
	/** A re-wording line (fork addition, 2026-11-02): `name`/`statement` replace
	 *  the earlier wording — the LAST reworded line wins. Set when a course's
	 *  language differs from the one the skill was written in. */
	reworded?: boolean;
}

/** A skill as read: its lines merged by id (core/skills.ts mergeSkillLines). */
export type Skill = SkillLine;

// ─── Courses (data/courses/<id>.json) ───────────────────────────────────────

/** new: no draft yet · drafting: the planner is running · draft: a draft
 *  awaits approval · active: approved (a later draft may also be waiting)
 *  · error: the last drafting run failed (see `error`). */
export type CourseStatus = "new" | "drafting" | "draft" | "active" | "error";

/** One skill of a planner draft. `requires` names other draft KEYS. */
export interface DraftSkill {
	/** Draft-local key ("s1", "s2", …). */
	key: string;
	/** An EXISTING skill id this IS (the identity judgment) — approval
	 *  link-appends to it instead of minting a new skill. */
	reuse?: string;
	name: string;
	statement: string;
	requires: string[];
	/** Existing proposition ids the skill rests on. */
	restsOn: string[];
	/** Where the curriculum asks for it ("Ch. 3, p. 41"). */
	cite?: string;
}

/** The planner's output, waiting for the owner's approval. */
export interface CourseDraft {
	createdAt: string;
	/** Short prose: the approach, and which skills it reused. */
	summary: string;
	/** The owner's change request this draft answered. */
	feedback?: string;
	skills: DraftSkill[];
}

/** One drafting run's usage (the money channel — like ExtractionRunUsage). */
export interface CourseDraftUsage {
	startedAt: number;
	at: string;
	durationMs: number;
	planner: ExtractionStageUsage;
}

export interface CourseRecord {
	/** "course_" + random. */
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	status: CourseStatus;
	/** The APPROVED skill set ([] until the first approval). */
	skills: string[];
	/** The pending planner output (cleared on approval). */
	draft?: CourseDraft;
	/** The course's language (fork addition, 2026-11-02): what the planner writes the skill map in and
	 *  what its sessions are taught in. Stamped from the default language at creation; absent (a
	 *  course made before languages) = the current default language. */
	language?: LessonLanguage;
	/** The learner's time note for this course ("exam Thursday, 4 concepts", fork addition 2026-11-01).
	 *  Read every turn by the course's sessions as data about the learner (core/pace.ts). */
	note?: string;
	/** The course's default pace (fork addition, 2026-11-09, core/pace.ts): stamped on sessions started from
	 *  the course (a Learn start's own pick wins). Absent = the global default (general.pace). */
	pace?: Pace;
	/** The exam date, "YYYY-MM-DD" (fork addition, 2026-11-13, core/exam-plan.ts): the course page counts down to it and
	 *  says whether the recent pace gets through the remaining skills. */
	examDate?: string;
	/** How much the course's exams use each skill (0-3), from a "Weigh by exams" pass or the learner's own edit.
	 *  Absent skill = weight 1. Moves with the next three fields as one unit in a sync. */
	skillWeights?: SkillWeights;
	/** The weighing pass's own summary (it says when it found no past exams). */
	weightsSummary?: string;
	/** ISO — when the weighing pass last finished. */
	weightsAt?: string;
	/** Why the last weighing pass failed. */
	weightsError?: string;
	/** Why the last drafting run failed. */
	error?: string;
	/** Append-only planner usage log. */
	drafts?: CourseDraftUsage[];
	/** Schema stamp — lazy v1, same rule as chat records. */
	version?: number;
}

export const CURRENT_COURSE_VERSION = 1;

// ─── The session's course link (ChatRecord.course) ──────────────────────────

/** learn: a teach session aimed at one skill · practice/review/placement:
 *  practice sessions whose concluded problems move the skills' boxes ·
 *  check: the context check (owner) — a SHORT practice session
 *  on a skill the learner already has from another course, confirming it
 *  works in this one. */
export type CourseMode = "learn" | "practice" | "review" | "placement" | "check";

export const COURSE_MODES: readonly CourseMode[] = ["learn", "practice", "review", "placement", "check"];

/** Stamped at creation by the course-session route; never changed. */
export interface ChatCourseLink {
	courseId: string;
	mode: CourseMode;
	/** The skills the session works on. */
	skillIds: string[];
}

// ─── The API payloads ───────────────────────────────────────────────────────

/** The sidebar's course row. */
export interface CourseSummary {
	id: string;
	title: string;
	status: CourseStatus;
	updatedAt: string;
	total: number;
	known: number;
	/** 0–100: the average of each skill's understanding over the known line, capped (core/mastery.ts courseProgressPercent). */
	progress: number;
	/** Skills that need review now (retrievability below the FSRS target). */
	needsReview: number;
	/** The exam date, when set. */
	examDate?: string;
}

/** One line of the sidebar's Today list (GET /api/today): a course with something to do. */
export interface TodayCourse {
	courseId: string;
	title: string;
	examDate?: string;
	daysLeft?: number;
	/** Reviews due, and how many the next review takes (0 = none due). */
	reviewDue: number;
	reviewBatch: number;
	/** The lessons to take today, in order. */
	lessons: Array<{ skillId: string; name: string; weight: number }>;
}

/** One skill's state in a course view. */
export interface CourseSkillView {
	id: string;
	name: string;
	statement: string;
	requires: string[];
	/** 0–10, how long the skill lasts (core/mastery.ts); 0 = not learned. */
	understanding: number;
	/** A finished lesson or any credit; unlocks what builds on it. */
	learned: boolean;
	/** understanding ≥ KNOWN_UNDERSTANDING. */
	known: boolean;
	/** Recall now is below the FSRS target (90%). */
	needsReview: boolean;
	/** ISO — when recall reaches the target; null = not learned. */
	reviewAt: string | null;
	/** FSRS stability in days (recall falls to 90% this long after `lastReview`); null = not learned. Lets the page
	 *  compute recall now without a refetch (core/mastery.ts recallAt). */
	stability: number | null;
	/** ISO — the last review; null = not learned. */
	lastReview: string | null;
	/** The prerequisites not learned yet (locked skills). */
	missing: string[];
	/** The skill's exam weight in this course (0-3; 1 = unknown) and who set it; `priority` also counts what it unlocks. */
	weight: number;
	weightBy?: "model" | "learner";
	weightReason?: string;
	priority: number;
	/** What its last finished lesson said the learner showed and should practice (the finish_lesson summary). */
	lessonNote?: { summary: string; at: string; chatId: string };
	/** The propositions it rests on: stored links ∪ derived from Learn sessions. */
	propositions: Array<{ id: string; name: string; statement: string; sessions: Array<{ id: string; title: string }> }>;
}

/** One concluded problem's effect on its skills (GET /api/chats/[id]/rating-changes, owner 2026-11-13). */
export interface RatingChange {
	/** The conclude call's id. */
	callId: string;
	skills: Array<{ id: string; name: string; before: number; after: number; reviewAt: string | null }>;
}

/** GET /api/chats/[id]/lesson-result: the card under a finished lesson (owner, 2026-11-13). */
export interface LessonResult {
	courseId: string;
	skill: { id: string; name: string };
	understanding: number;
	learned: boolean;
	/** ISO — when recall reaches the review target. */
	reviewAt: string | null;
	summary: string | null;
	/** The next skill in the course's order, when one is ready (not this skill). */
	next: { id: string; name: string } | null;
}

/** GET /api/courses/[id]. */
export interface CourseView {
	course: CourseRecord;
	/** Every approved skill, in topological order (prerequisites first). */
	skills: CourseSkillView[];
	/** Ids, topological order. */
	review: string[];
	/** How many of `review` the next Review session takes (the session cap). */
	reviewBatch: number;
	/** Not learned, prerequisites learned — what to learn next, by exam priority (core/exam-plan.ts). */
	nextUp: string[];
	/** Next-up skills the exams never use and that unlock nothing examined (weight 0): kept apart, still learnable. */
	notExamined: string[];
	/** The exam countdown, forecast and today's lessons. */
	plan: CoursePlan;
	/** Learned, not known yet — what to practice. */
	learning: string[];
	locked: string[];
	known: string[];
	/** Learned or known from ANOTHER course, never yet shown in this one —
	 *  offered a short context check, never forced (they also stay in
	 *  `known` / `learning`, which the counts read). */
	contextCheck: string[];
	/** Course sessions, newest first. `finished`: a Learn session's finish. */
	sessions: Array<{ id: string; title: string; mode: CourseMode; updatedAt: string; finished?: boolean }>;
	/** Existing skills a draft reuses, by id (to show their names). */
	reused: Record<string, { name: string; statement: string }>;
}
