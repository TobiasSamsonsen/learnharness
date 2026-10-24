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
 *  practice sessions whose concluded problems move the skills' boxes. */
export type CourseMode = "learn" | "practice" | "review" | "placement";

export const COURSE_MODES: readonly CourseMode[] = ["learn", "practice", "review", "placement"];

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
	/** Skills due for review now. */
	due: number;
}

/** One skill's state in a course view. */
export interface CourseSkillView {
	id: string;
	name: string;
	statement: string;
	requires: string[];
	box: number;
	known: boolean;
	due: boolean;
	/** ISO — when the skill next comes due; null at box 0 (always due). */
	dueAt: string | null;
	/** The prerequisites not known yet (locked skills). */
	missing: string[];
	/** The propositions it rests on: stored links ∪ derived from Learn sessions. */
	propositions: Array<{ id: string; name: string; statement: string; sessions: Array<{ id: string; title: string }> }>;
}

/** GET /api/courses/[id]. */
export interface CourseView {
	course: CourseRecord;
	/** Every approved skill, in topological order (prerequisites first). */
	skills: CourseSkillView[];
	/** Ids, topological order. */
	review: string[];
	nextUp: string[];
	locked: string[];
	known: string[];
	/** Course sessions, newest first. */
	sessions: Array<{ id: string; title: string; mode: CourseMode; updatedAt: string }>;
	/** Existing skills a draft reuses, by id (to show their names). */
	reused: Record<string, { name: string; statement: string }>;
}
