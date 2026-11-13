import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
	ChatCourseLink,
	LessonResult,
	RatingChange,
	CourseDraft,
	CourseMode,
	CourseRecord,
	CourseSkillView,
	CourseSummary,
	CourseView,
	GraphEdge,
	GraphSkillLayer,
	GraphSkillNode,
	Skill,
	TodayCourse,
} from "../core/contracts.ts";
import {
	daysUntil,
	forecast,
	lessonsPerDay,
	lessonsToday,
	mergeModelWeights,
	orderNextUp,
	parseExamDate,
	parseWeightValue,
	priorities,
	sanitizeWeights,
	weightOf,
	type CoursePlan,
	type SkillWeights,
} from "../core/exam-plan.ts";
import { approveDraft, draftProblems, type DraftCheckContext } from "../core/course-draft.ts";
import {
	finishSummaryOf,
	courseFirstMessage,
	coursePromptSection,
	courseSessionTitle,
	newCourseContextMessage,
	type SessionSkill,
} from "../core/course-session.ts";
import { chainsForSelection, formatChainLine } from "../core/chains.ts";
import { getGraph } from "../core/graph.ts";
import {
	courseProgressPercent,
	foldSkills,
	inCourseEvidence,
	isKnown,
	needsReview,
	partitionSkills,
	pickReviewSkills,
	REVIEW_SESSION_SIZE,
	reviewAt,
	skillEventsOf,
	understandingOf,
	type SkillState,
	type SkillEvent,
	type SkillPartition,
} from "../core/mastery.ts";
import { DEFAULT_LESSON_LANGUAGE, type LessonLanguage } from "../core/language.ts";
import { materialBlock } from "../core/materials.ts";
import { normalizePaceNote, type Pace } from "../core/pace.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { mergeSkillLines } from "../core/skills.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { draftCourse } from "../agent/subagents/course-planner.ts";
import { weighCourse } from "../agent/subagents/exam-weigher.ts";
import { callUsage } from "../agent/subagents/extraction.ts";
import { materialTools } from "../agent/tools/materials.ts";
import { plannerGraphTools } from "../agent/tools/planner-graph.ts";
import { stampNewSession } from "./chats.ts";
import { listMaterials, removeMaterial, waitForMaterials } from "./materials.ts";
import { stores } from "./stores.ts";

/**
 * Courses — the service seam (fork addition, 2026-10-24; spec:
 * docs/courses.md). Routes (app/api/courses/*) delegate here.
 *
 *   - READS derive everything: skills merge from the ledger, boxes fold
 *     from every course practice session's concluded problems (a skill's
 *     box is global — practice in one course counts in every course that
 *     shares the skill), the route partitions from boxes + requires.
 *   - DRAFTING runs the course planner in the background (one run per
 *     course, through the shared background-LLM permits) and parks its
 *     output on the record for the owner to review.
 *   - APPROVAL is the skills ledger's ONLY writer.
 *   - SESSIONS start from a course with the course link stamped at birth
 *     and a context marker as message[0].
 */

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

// ─── derived reads ───────────────────────────────────────────────────────────

/** Every skill in the graph (merged; dead proposition links dropped). */
function allSkills(nodeIds: ReadonlySet<string>): Map<string, Skill> {
	return new Map(mergeSkillLines(stores.skillStore.readSkillLines(), nodeIds).map((s) => [s.id, s]));
}

/** Every course-linked session record. */
function courseChats() {
	return stores.chatStore
		.listChats()
		.filter((c) => c.course)
		.map((c) => stores.chatStore.getChat(c.id))
		.filter((r) => r !== null && r.course !== undefined);
}

/** A skill's lesson note: the summary its newest finished lesson gave (core/course-session.ts finishSummaryOf). */
interface LessonNote {
	summary: string;
	at: number;
	chatId: string;
}

/** Every course session's skill evidence, by course, and each skill's lesson note, in one pass over the chats. */
function courseEvidence(): { byCourse: Map<string, SkillEvent[]>; notes: Map<string, LessonNote> } {
	const byCourse = new Map<string, SkillEvent[]>();
	const notes = new Map<string, LessonNote>();
	for (const chat of courseChats()) {
		const link = chat!.course!;
		byCourse.set(link.courseId, [...(byCourse.get(link.courseId) ?? []), ...skillEventsOf(chat!.messages, link)]);
		if (link.mode !== "learn") continue;
		const note = finishSummaryOf(chat!.messages);
		if (!note) continue;
		for (const skillId of link.skillIds) {
			const held = notes.get(skillId);
			if (!held || held.at < note.at) notes.set(skillId, { summary: note.summary, at: note.at, chatId: chat!.id });
		}
	}
	return { byCourse, notes };
}

interface ReadContext {
	graph: ReturnType<typeof getGraph>;
	nodeIds: Set<string>;
	skills: Map<string, Skill>;
	/** A skill's memory state is global: evidence from every course counts. */
	skillStates: Map<string, SkillState>;
	byCourse: Map<string, SkillEvent[]>;
	/** Each skill's newest lesson note. */
	notes: Map<string, LessonNote>;
	now: number;
}

function readContext(): ReadContext {
	const graph = getGraph(stores.graphStore);
	const nodeIds = new Set(graph.nodes.map((n) => n.id));
	const skills = allSkills(nodeIds);
	const { byCourse, notes } = courseEvidence();
	const skillStates = foldSkills([...byCourse.values()].flat(), (id) => skills.get(id)?.requires ?? []);
	return { graph, nodeIds, skills, skillStates, byCourse, notes, now: Date.now() };
}

function checkContext(ctx = readContext()): DraftCheckContext {
	return { skills: ctx.skills, nodeIds: ctx.nodeIds };
}

/** A skill's propositions: the planner's stored links ∪ every proposition
 *  extracted from a Learn session on the skill (derived, not stored). */
function skillPropositionIds(skill: Skill, ctx: ReadContext, learnChats: ReadonlyMap<string, Set<string>>): string[] {
	const ids = new Set(skill.restsOn);
	const chats = learnChats.get(skill.id);
	if (chats && chats.size > 0) {
		for (const node of ctx.graph.nodes) {
			if (node.provenance.some((pt) => chats.has(pt.chatId))) ids.add(node.id);
		}
	}
	return [...ids].filter((id) => ctx.nodeIds.has(id));
}

/** skill id → the Learn sessions started on it. */
function learnChatsBySkill(): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const chat of stores.chatStore.listChats()) {
		if (chat.course?.mode !== "learn") continue;
		for (const id of chat.course.skillIds) {
			if (!out.has(id)) out.set(id, new Set());
			out.get(id)!.add(chat.id);
		}
	}
	return out;
}

function partitionOf(course: CourseRecord, ctx: ReadContext): SkillPartition {
	const inCourse = inCourseEvidence(ctx.byCourse.get(course.id) ?? [], (id) => ctx.skills.get(id)?.requires ?? []);
	return partitionSkills(course.skills, ctx.skills, ctx.skillStates, ctx.now, inCourse);
}

export function listCourseSummaries(): CourseSummary[] {
	const courses = stores.courseStore.listCourses().map(healOrphanDraft);
	if (courses.length === 0) return [];
	const ctx = readContext();
	return courses.map((course) => {
		const p = partitionOf(course, ctx);
		return {
			id: course.id,
			title: course.title,
			status: course.status,
			updatedAt: course.updatedAt,
			total: p.order.length,
			known: p.known.length,
			progress: courseProgressPercent(p.order.map((id) => {
				const state = p.states.get(id)?.state;
				return state ? understandingOf(state) : 0;
			})),
			needsReview: p.review.length,
			...(course.examDate ? { examDate: course.examDate } : {}),
		};
	});
}

/** The knowledge graph's skills layer (owner, 2026-10-25): every skill the
 *  learner holds (learned or known), its prerequisite arrows among the
 *  held skills, an arrow from each proposition it rests on (the course
 *  page's derivation), and one region per course. Undefined when nothing
 *  is held. */
export function graphSkillLayer(): GraphSkillLayer | undefined {
	const ctx = readContext();
	const courses = stores.courseStore.listCourses();
	const coursesOf = new Map<string, Array<{ id: string; title: string }>>();
	for (const course of courses) {
		for (const id of course.skills) coursesOf.set(id, [...(coursesOf.get(id) ?? []), { id: course.id, title: course.title }]);
	}
	const learnChats = learnChatsBySkill();
	const nodes: GraphSkillNode[] = [];
	for (const [id, state] of ctx.skillStates) {
		const skill = ctx.skills.get(id);
		if (!skill) continue;
		nodes.push({
			id,
			name: skill.name,
			statement: skill.statement,
			understanding: understandingOf(state),
			known: isKnown(state),
			needsReview: needsReview(state, ctx.now),
			courses: coursesOf.get(id) ?? [],
			propositions: skillPropositionIds(skill, ctx, learnChats),
		});
	}
	if (nodes.length === 0) return undefined;
	nodes.sort((a, b) => b.understanding - a.understanding || a.name.localeCompare(b.name));
	const held = new Set(nodes.map((n) => n.id));
	const edges: GraphEdge[] = [];
	for (const n of nodes) {
		for (const req of ctx.skills.get(n.id)!.requires) if (held.has(req)) edges.push({ from: req, to: n.id });
		for (const p of n.propositions) edges.push({ from: p, to: n.id });
	}
	const regions = courses
		.map((course) => ({ id: course.id, label: course.title, members: nodes.filter((n) => n.courses[0]?.id === course.id).map((n) => n.id) }))
		.filter((r) => r.members.length > 0);
	return { nodes, edges, regions };
}

/** The exam plan of a course (core/exam-plan.ts): priorities, the ordered Next up, the countdown, the forecast and today's
 *  lessons. `ids` are the course's skills in topological order. */
function examPlanOf(course: CourseRecord, p: SkillPartition, ctx: ReadContext): { plan: CoursePlan; nextUp: string[]; notExamined: string[]; priority: Map<string, number> } {
	const weights = sanitizeWeights(course.skillWeights);
	const priority = priorities(p.order, (id) => ctx.skills.get(id)?.requires ?? [], weights);
	const { nextUp, notExamined } = orderNextUp(p.nextUp, priority);
	const skillsLeft = nextUp.length + p.locked.filter((id) => (priority.get(id) ?? 1) > 0).length;
	const events = ctx.byCourse.get(course.id) ?? [];
	const finishes = events.filter((e) => e.outcome === "finished").map((e) => e.at);
	const firstActivity = events.length > 0 ? Math.min(...events.map((e) => e.at)) : undefined;
	const daysLeft = course.examDate ? daysUntil(course.examDate, ctx.now) : undefined;
	const f = daysLeft === undefined ? undefined : forecast({ skillsLeft, daysLeft, pacePerDay: lessonsPerDay(finishes, ctx.now, firstActivity) });
	const lessons = nextUp.slice(0, lessonsToday(f ? f.neededPerDay : null, nextUp.length));
	const plan: CoursePlan = {
		...(course.examDate ? { examDate: course.examDate } : {}),
		...(daysLeft !== undefined ? { daysLeft } : {}),
		skillsLeft,
		...(f ? { forecast: f } : {}),
		reviewDue: p.review.length,
		reviewBatch: Math.min(p.review.length, REVIEW_SESSION_SIZE),
		lessons,
	};
	return { plan, nextUp, notExamined, priority };
}

/** The sidebar's Today list (GET /api/today, owner 2026-11-13): per active course with something to do, the reviews
 *  that are due and the lessons to take today. Courses with the soonest exam first, then the rest by recent use. */
export function todayCourses(): TodayCourse[] {
	const courses = stores.courseStore.listCourses().filter((c) => c.status === "active" && c.skills.length > 0);
	if (courses.length === 0) return [];
	const ctx = readContext();
	const out: Array<TodayCourse & { updatedAt: string }> = [];
	for (const course of courses) {
		const p = partitionOf(course, ctx);
		const { plan } = examPlanOf(course, p, ctx);
		if (plan.reviewDue === 0 && plan.lessons.length === 0) continue;
		const weights = sanitizeWeights(course.skillWeights);
		out.push({
			courseId: course.id,
			title: course.title,
			...(plan.examDate ? { examDate: plan.examDate } : {}),
			...(plan.daysLeft !== undefined ? { daysLeft: plan.daysLeft } : {}),
			reviewDue: plan.reviewDue,
			reviewBatch: plan.reviewBatch,
			lessons: plan.lessons.map((id) => ({ skillId: id, name: ctx.skills.get(id)?.name ?? id, weight: weightOf(weights, id) })),
			updatedAt: course.updatedAt,
		});
	}
	const upcoming = (c: TodayCourse): boolean => c.daysLeft !== undefined && c.daysLeft >= 0;
	out.sort((a, b) => {
		if (upcoming(a) !== upcoming(b)) return upcoming(a) ? -1 : 1;
		if (upcoming(a) && upcoming(b)) return (a.daysLeft ?? 0) - (b.daysLeft ?? 0);
		return b.updatedAt.localeCompare(a.updatedAt);
	});
	return out.map(({ updatedAt: _updatedAt, ...rest }) => rest);
}

export function courseView(courseId: string): CourseView | null {
	const found = stores.courseStore.getCourse(courseId);
	if (!found) return null;
	const course = healOrphanDraft(found);
	const ctx = readContext();
	const p = partitionOf(course, ctx);
	const learnChats = learnChatsBySkill();
	const titles = new Map(stores.chatStore.listChats().map((c) => [c.id, c.title]));
	const nodes = new Map(ctx.graph.nodes.map((n) => [n.id, n]));
	const exam = examPlanOf(course, p, ctx);
	const weights = sanitizeWeights(course.skillWeights);
	const skills: CourseSkillView[] = p.order.map((id) => {
		const skill = ctx.skills.get(id)!;
		const s = p.states.get(id)!;
		return {
			id,
			name: skill.name,
			statement: skill.statement,
			requires: skill.requires.filter((r) => ctx.skills.has(r)),
			understanding: s.state ? understandingOf(s.state) : 0,
			learned: s.learned,
			known: s.known,
			needsReview: s.needsReview,
			reviewAt: s.state ? new Date(reviewAt(s.state)).toISOString() : null,
			stability: s.state ? s.state.stability : null,
			lastReview: s.state ? new Date(s.state.lastReview).toISOString() : null,
			missing: s.missing,
			...(ctx.notes.get(id) ? { lessonNote: { summary: ctx.notes.get(id)!.summary, at: new Date(ctx.notes.get(id)!.at).toISOString(), chatId: ctx.notes.get(id)!.chatId } } : {}),
			weight: weightOf(weights, id),
			...(weights?.[id] ? { weightBy: weights[id]!.by } : {}),
			...(weights?.[id]?.reason ? { weightReason: weights[id]!.reason } : {}),
			priority: exam.priority.get(id) ?? weightOf(weights, id),
			propositions: skillPropositionIds(skill, ctx, learnChats).map((nid) => {
				const node = nodes.get(nid)!;
				const sessions = [...new Set(node.provenance.map((pt) => pt.chatId))]
					.filter((cid) => titles.has(cid))
					.map((cid) => ({ id: cid, title: titles.get(cid)! }));
				return { id: nid, name: node.name, statement: node.statement, sessions };
			}),
		};
	});
	const sessions = stores.chatStore
		.listChats()
		.filter((c) => c.course?.courseId === courseId)
		.map((c) => ({
			id: c.id,
			title: c.title,
			mode: c.course!.mode,
			updatedAt: c.updatedAt,
			// listChats already folded this (sessionFinishOf over the record) while it had the
			// record open — re-reading the chat file here only to ask again cost a full parse.
			...(c.finished ? { finished: true } : {}),
		}));
	const reused: CourseView["reused"] = {};
	for (const d of course.draft?.skills ?? []) {
		const existing = d.reuse ? ctx.skills.get(d.reuse) : undefined;
		if (existing) reused[existing.id] = { name: existing.name, statement: existing.statement };
	}
	return {
		course,
		skills,
		review: p.review,
		reviewBatch: Math.min(p.review.length, REVIEW_SESSION_SIZE),
		nextUp: exam.nextUp,
		notExamined: exam.notExamined,
		plan: exam.plan,
		learning: p.learning,
		locked: p.locked,
		known: p.known,
		contextCheck: p.contextCheck,
		sessions,
		reused,
	};
}

// ─── create / rename / delete ────────────────────────────────────────────────

/** A course's language: its own stamp, else the CURRENT default language (a course made before
 *  languages has none) — unlike a lesson, whose missing stamp means English. */
function courseLanguage(course: CourseRecord): LessonLanguage {
	return course.language ?? stores.settingsStore.readSettings()?.general?.language ?? DEFAULT_LESSON_LANGUAGE;
}

/** A new course, stamped with the default language (fork addition, 2026-11-02). */
export function createCourse(title: string): CourseRecord {
	const created = stores.courseStore.createCourse(title);
	return stores.courseStore.updateCourse(created.id, { language: courseLanguage(created) }) ?? created;
}

/** Set a course's language: read by its next draft and stamped on the sessions started from it. */
export function setCourseLanguage(courseId: string, language: LessonLanguage): CourseRecord | null {
	return stores.courseStore.updateCourse(courseId, { language });
}

export function renameCourse(courseId: string, title: string): CourseRecord | null {
	return stores.courseStore.updateCourse(courseId, { title: title.trim() || "Untitled course" });
}

/** Set or clear (undefined) a course's default pace (fork addition, 2026-11-09 — core/pace.ts). Cleared = the global default. */
export function setCoursePace(courseId: string, pace: Pace | undefined): CourseRecord | null {
	return stores.courseStore.updateCourse(courseId, { pace });
}

/** Parse the PATCH body's `examDate`: a real calendar date, or null to clear it. */
export function parseExamDateField(raw: unknown): { ok: true; date: string | undefined } | { ok: false; error: string } {
	if (raw === null || raw === "") return { ok: true, date: undefined };
	const date = parseExamDate(raw);
	return date ? { ok: true, date } : { ok: false, error: "examDate must be a date like 2026-12-12, or null" };
}

/** Set or clear a course's exam date (fork addition, 2026-11-13 — core/exam-plan.ts). */
export function setCourseExamDate(courseId: string, examDate: string | undefined): CourseRecord | null {
	return stores.courseStore.updateCourse(courseId, { examDate });
}

/** Parse the PATCH body's `weights`: { skillId: 0-3 | null }, null clearing a skill's entry. */
export function parseWeightsField(raw: unknown): { ok: true; weights: Record<string, number | null> } | { ok: false; error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "weights must be an object of skill id to 0-3 or null" };
	const out: Record<string, number | null> = {};
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value === null) out[id] = null;
		else if (parseWeightValue(value) !== null) out[id] = value as number;
		else return { ok: false, error: `the weight of ${id} must be 0, 1, 2, 3 or null` };
	}
	return { ok: true, weights: out };
}

/** The learner sets (or clears) skills' exam weights by hand; a hand edit survives a re-weigh. Only the course's own skills. */
export function setCourseSkillWeights(courseId: string, edits: Record<string, number | null>): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	const own = new Set(course.skills);
	const stranger = Object.keys(edits).find((id) => !own.has(id));
	if (stranger) return { ok: false, status: 400, error: `${stranger} is not a skill of this course` };
	const next: SkillWeights = { ...(sanitizeWeights(course.skillWeights) ?? {}) };
	for (const [id, value] of Object.entries(edits)) {
		if (value === null) delete next[id];
		else next[id] = { w: parseWeightValue(value)!, by: "learner" };
	}
	const updated = stores.courseStore.updateCourse(courseId, { skillWeights: Object.keys(next).length > 0 ? next : undefined })!;
	return { ok: true, value: updated };
}

/** Set or clear a course's time note (fork addition, 2026-11-01 — core/pace.ts). Blank clears it. */
export function setCourseNote(courseId: string, note: string | undefined): CourseRecord | null {
	return stores.courseStore.updateCourse(courseId, { note: normalizePaceNote(note) });
}

/** Delete a course: its record and its material. Its skills stay in the
 *  graph (shared, with their history); its sessions stay, unlabelled. */
export function deleteCourse(courseId: string): boolean {
	if (!stores.courseStore.getCourse(courseId)) return false;
	draftRuns().get(courseId)?.abort();
	weighRuns().get(courseId)?.abort();
	for (const m of stores.materialStore.list(courseId)) removeMaterial(courseId, m.id);
	stores.materialStore.removeAll(courseId);
	return stores.courseStore.deleteCourse(courseId);
}

// ─── drafting ────────────────────────────────────────────────────────────────

const RUNS_KEY = Symbol.for("lh.courseDraftRuns");
function draftRuns(): Map<string, AbortController> {
	const g = globalThis as Record<symbol, Map<string, AbortController> | undefined>;
	g[RUNS_KEY] ??= new Map();
	return g[RUNS_KEY];
}

/** How many courses are being drafted right now (the idle check reads this). */
export function courseDraftCount(): number {
	return draftRuns().size;
}

/** Is a drafting run live for this course? */
export function courseDrafting(courseId: string): boolean {
	return draftRuns().has(courseId);
}

// ─── weighing by exams (owner, 2026-11-13 — agent/subagents/exam-weigher.ts) ─

const WEIGH_KEY = Symbol.for("lh.courseWeighRuns");
function weighRuns(): Map<string, AbortController> {
	const g = globalThis as Record<symbol, Map<string, AbortController> | undefined>;
	g[WEIGH_KEY] ??= new Map();
	return g[WEIGH_KEY];
}

/** Is a weighing pass live for this course? */
export function courseWeighing(courseId: string): boolean {
	return weighRuns().has(courseId);
}

/** Start the "Weigh by exams" pass. Returns at once; the run writes the weights on the record and announces it. */
export function startCourseWeighing(courseId: string): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (course.skills.length === 0) return { ok: false, status: 400, error: "Approve the skill map first" };
	if (weighRuns().has(courseId)) return { ok: false, status: 409, error: "The skills are already being weighed" };
	if (listMaterials(courseId).length === 0) return { ok: false, status: 400, error: "Add the curriculum first (past exams count most)" };
	const controller = new AbortController();
	weighRuns().set(courseId, controller);
	const updated = stores.courseStore.updateCourse(courseId, { weightsError: undefined })!;
	void runWeigh(courseId, controller).finally(() => weighRuns().delete(courseId));
	return { ok: true, value: updated };
}

async function runWeigh(courseId: string, controller: AbortController): Promise<void> {
	const settle = (patch: Partial<CourseRecord>) => {
		if (stores.courseStore.getCourse(courseId)) stores.courseStore.updateCourse(courseId, patch);
	};
	try {
		await waitForMaterials(courseId);
		const course = stores.courseStore.getCourse(courseId);
		if (!course || controller.signal.aborted) return;
		const spec = resolveRoleSpec("coursePlanner", stores.settingsStore.readSettings());
		if (!spec) {
			settle({ weightsError: "No model is configured for the course planner (Settings → Agent: the strong slot or a Course planner override)" });
			return;
		}
		const materials = listMaterials(courseId);
		const materialsSection = `<curriculum>\n${materials.map((m) => materialBlock(m, stores.materialStore.filePath(courseId, m))).join("\n\n")}\n</curriculum>`;
		const ctx = readContext();
		const skills = course.skills
			.map((id) => ctx.skills.get(id))
			.filter((s): s is Skill => s !== undefined)
			.map((s) => ({ id: s.id, name: s.name, statement: s.statement }));
		const result = await weighCourse(
			{ title: course.title, materialsSection, skills, language: courseLanguage(course) },
			{
				engine: piEngineForSpec(spec),
				signal: controller.signal,
				tools: materialTools({ chatId: courseId, store: stores.materialStore }),
				onStep: () => {},
				courseId,
			},
		);
		const fresh = stores.courseStore.getCourse(courseId);
		if (!fresh) return; // deleted mid-run
		// a hand edit made while the pass ran (or before it) stays: the pass only fills in the model's weights
		const merged = mergeModelWeights(sanitizeWeights(fresh.skillWeights), result.weights, fresh.skills);
		settle({ skillWeights: merged, weightsSummary: result.summary, weightsAt: new Date().toISOString(), weightsError: undefined });
	} catch (err) {
		if (controller.signal.aborted) return;
		settle({ weightsError: err instanceof Error ? err.message : String(err) });
	}
}

/** A course left "drafting" by a run that no longer exists (the process
 *  restarted or crashed mid-draft — the status is on disk, the run only in
 *  memory) would spin forever with its Draft button disabled. Settle it
 *  the way a failed draft settles, and say what happened. */
function healOrphanDraft(course: CourseRecord): CourseRecord {
	if (course.status !== "drafting" || draftRuns().has(course.id)) return course;
	return (
		stores.courseStore.updateCourse(course.id, {
			status: course.skills.length > 0 ? "active" : course.draft ? "draft" : "error",
			error: "Drafting was interrupted (the app restarted) — draft again.",
		}) ?? course
	);
}

/** Start drafting (or re-drafting with the owner's feedback). Returns at
 *  once; the run parks its draft on the record and announces it. */
export function startCourseDraft(courseId: string, feedback?: string): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (draftRuns().has(courseId)) return { ok: false, status: 409, error: "The skill map is already being drafted" };
	if (listMaterials(courseId).length === 0) return { ok: false, status: 400, error: "Add the curriculum first (PDFs, notes or links)" };
	const changeRequest = feedback?.trim();
	if (changeRequest && !course.draft) return { ok: false, status: 400, error: "There is no draft to change — draft the skill map first" };
	const controller = new AbortController();
	draftRuns().set(courseId, controller);
	const updated = stores.courseStore.updateCourse(courseId, { status: "drafting", error: undefined })!;
	void runDraft(courseId, changeRequest || undefined, controller).finally(() => draftRuns().delete(courseId));
	return { ok: true, value: updated };
}

async function runDraft(courseId: string, feedback: string | undefined, controller: AbortController): Promise<void> {
	const startedAt = Date.now();
	const steps: ReturnType<typeof callUsage>[] = [];
	let model = "unknown";
	const settle = (patch: Partial<CourseRecord>) => {
		const current = stores.courseStore.getCourse(courseId);
		if (!current) return; // deleted mid-run
		const usage = steps.length > 0
			? [...(current.drafts ?? []), { startedAt, at: new Date().toISOString(), durationMs: Date.now() - startedAt, planner: { model, steps } }]
			: current.drafts;
		stores.courseStore.updateCourse(courseId, { ...patch, ...(usage ? { drafts: usage } : {}) });
	};
	try {
		await waitForMaterials(courseId);
		const course = stores.courseStore.getCourse(courseId);
		if (!course || controller.signal.aborted) return;
		const spec = resolveRoleSpec("coursePlanner", stores.settingsStore.readSettings());
		if (!spec) {
			settle({ status: course.skills.length > 0 ? "active" : "error", error: "No model is configured for the course planner (Settings → Agent: the strong slot or a Course planner override)" });
			return;
		}
		const materials = listMaterials(courseId);
		const materialsSection = `<curriculum>\n${materials
			.map((m) => materialBlock(m, stores.materialStore.filePath(courseId, m)))
			.join("\n\n")}\n</curriculum>`;
		const ctx = readContext();
		const approved = course.skills
			.map((id) => ctx.skills.get(id))
			.filter((s): s is Skill => s !== undefined)
			.map((s) => ({ id: s.id, name: s.name, statement: s.statement }));
		const tools: Record<string, AgentTool<any>> = {
			...materialTools({ chatId: courseId, store: stores.materialStore }),
			...plannerGraphTools({ chatStore: stores.chatStore, graphStore: stores.graphStore }),
		};
		// The planner's model requests pass the process-wide worker-request admission (agent/worker-request-admission.ts),
		// the one background-LLM pool: no wrapper of its own.
		const result = await draftCourse(
			{
				title: course.title,
				materials: materials.map((m) => ({ id: m.id, name: m.name })),
				materialsSection,
				...(feedback && course.draft ? { previous: { draft: course.draft, feedback } } : {}),
				...(approved.length > 0 ? { approved } : {}),
				language: courseLanguage(course),
			},
			{
				engine: piEngineForSpec(spec),
				signal: controller.signal,
				checkContext: () => checkContext(),
				tools,
				courseId,
				onStep: (usage, m) => {
					model = m;
					steps.push(callUsage(usage));
				},
			},
		);
		const draft: CourseDraft = {
			createdAt: new Date().toISOString(),
			summary: result.summary,
			...(feedback ? { feedback } : {}),
			skills: result.skills,
		};
		const fresh = stores.courseStore.getCourse(courseId);
		settle({ status: (fresh?.skills.length ?? 0) > 0 ? "active" : "draft", draft, error: undefined });
	} catch (err) {
		if (controller.signal.aborted) return;
		const current = stores.courseStore.getCourse(courseId);
		settle({
			status: (current?.skills.length ?? 0) > 0 ? "active" : current?.draft ? "draft" : "error",
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ─── approval (the skills ledger's ONLY writer) ──────────────────────────────

export function approveCourse(courseId: string): Result<CourseRecord> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (draftRuns().has(courseId)) return { ok: false, status: 409, error: "The skill map is still being drafted" };
	if (!course.draft) return { ok: false, status: 409, error: "There is no draft to approve" };
	const ctx = checkContext();
	const problems = draftProblems(course.draft.skills, ctx);
	if (problems.length > 0) {
		return { ok: false, status: 422, error: `The draft no longer fits the graph — ask for changes to re-draft it: ${problems.join("; ")}` };
	}
	const mint = () => `sk_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const { lines, skillIds } = approveDraft(course.draft, ctx, mint, new Date().toISOString());
	stores.skillStore.appendSkillLines(lines);
	const updated = stores.courseStore.updateCourse(courseId, { skills: skillIds, draft: undefined, status: "active", error: undefined })!;
	return { ok: true, value: updated };
}

// ─── sessions from a course ──────────────────────────────────────────────────

function sessionSkill(id: string, ctx: ReadContext): SessionSkill {
	const skill = ctx.skills.get(id)!;
	const state = ctx.skillStates.get(id);
	return {
		id,
		name: skill.name,
		statement: skill.statement,
		understanding: state ? understandingOf(state) : 0,
		learned: state !== undefined,
		known: state !== undefined && isKnown(state),
		needsReview: state !== undefined && needsReview(state, ctx.now),
		...(ctx.notes.get(id) ? { note: ctx.notes.get(id)!.summary } : {}),
	};
}

/** What each concluded problem of a course practice, review or check session did to its skills' understanding
 *  (owner, 2026-11-13): the memory model folded over every course's evidence before the problem and with it. Null for
 *  any other session. */
export function ratingChanges(chatId: string): RatingChange[] | null {
	const record = stores.chatStore.getChat(chatId);
	const link = record?.course;
	if (!record || !link || link.mode === "learn" || link.mode === "placement") return null;
	const ctx = readContext();
	const requiresOf = (id: string) => ctx.skills.get(id)?.requires ?? [];
	const all = [...ctx.byCourse.values()].flat();
	const own = skillEventsOf(record.messages, link);
	const clean = new Set<string>();
	for (const m of record.messages) {
		const r = m as { role?: string; toolCallId?: string; isError?: boolean };
		if (r.role === "toolResult" && !r.isError && r.toolCallId) clean.add(r.toolCallId);
	}
	const out: RatingChange[] = [];
	for (const m of record.messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const at = (m as { timestamp: number }).timestamp;
		for (const block of (m as unknown as { content: Array<{ type: string; id?: string; name?: string }> }).content) {
			if (block.type !== "toolCall" || block.name !== "conclude" || !block.id || !clean.has(block.id)) continue;
			const ids = [...new Set(own.filter((e) => e.at === at).map((e) => e.skillId))];
			if (ids.length === 0) continue;
			const before = foldSkills(all.filter((e) => e.at < at), requiresOf);
			const after = foldSkills(all.filter((e) => e.at <= at), requiresOf);
			out.push({
				callId: block.id,
				skills: ids.map((id) => {
					const b = before.get(id);
					const a = after.get(id);
					return {
						id,
						name: ctx.skills.get(id)?.name ?? id,
						before: b ? understandingOf(b) : 0,
						after: a ? understandingOf(a) : 0,
						reviewAt: a ? new Date(reviewAt(a)).toISOString() : null,
					};
				}),
			});
		}
	}
	return out;
}

/** The card under a finished lesson (GET /api/chats/[id]/lesson-result, owner 2026-11-13): the skill, its new
 *  understanding and review date, the teacher's summary, and the next skill in the course's order. Null when the chat is
 *  not a course Learn session. */
export function lessonResult(chatId: string): LessonResult | null {
	const record = stores.chatStore.getChat(chatId);
	const link = record?.course;
	if (!record || !link || link.mode !== "learn") return null;
	const course = stores.courseStore.getCourse(link.courseId);
	const skillId = link.skillIds[0];
	if (!course || !skillId) return null;
	const ctx = readContext();
	const skill = ctx.skills.get(skillId);
	if (!skill) return null;
	const state = ctx.skillStates.get(skillId);
	const p = partitionOf(course, ctx);
	const { nextUp } = examPlanOf(course, p, ctx);
	const next = nextUp.find((id) => id !== skillId);
	return {
		courseId: course.id,
		skill: { id: skillId, name: skill.name },
		understanding: state ? understandingOf(state) : 0,
		learned: state !== undefined,
		reviewAt: state ? new Date(reviewAt(state)).toISOString() : null,
		summary: finishSummaryOf(record.messages)?.summary ?? null,
		next: next ? { id: next, name: ctx.skills.get(next)?.name ?? next } : null,
	};
}

/** Create a session from a course (docs/courses.md §4). The client sends
 *  `prompt` as the first learner message. */
export function createCourseSession(
	courseId: string,
	mode: CourseMode,
	skillId?: string,
	/** The Learn dialog's pick (fork addition, 2026-11-09): this session's pace. Else the course's, else the global default. */
	pace?: Pace,
): Result<{ id: string; title: string; prompt: string }> {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return { ok: false, status: 404, error: "Unknown course" };
	if (course.skills.length === 0) return { ok: false, status: 409, error: "Approve the course's skill map first" };
	const ctx = readContext();
	const p = partitionOf(course, ctx);
	if (skillId !== undefined && !p.order.includes(skillId)) return { ok: false, status: 400, error: "That skill is not in this course" };
	let ids: string[];
	switch (mode) {
		case "learn":
			if (skillId === undefined) return { ok: false, status: 400, error: "Learn needs a skill" };
			ids = [skillId];
			break;
		case "practice":
			// "Practice all" practices what is learned but not known yet
			ids = skillId !== undefined ? [skillId] : p.learning;
			if (ids.length === 0) return { ok: false, status: 409, error: "Nothing to practice yet — finish a lesson first" };
			break;
		case "review":
			// one session's worth: the weakest, the stalest, a morale skill;
			// the rest stay due for the next session
			ids = pickReviewSkills(p);
			if (ids.length === 0) return { ok: false, status: 409, error: "Nothing needs review right now" };
			break;
		case "placement":
			// skills already had from another course get their own context
			// check — the placement test does not spend questions on them
			ids = p.order.filter((id) => !p.contextCheck.includes(id));
			if (ids.length === 0) return { ok: false, status: 409, error: "Every skill is already known from another course — use the context checks" };
			break;
		case "check":
			if (skillId === undefined) return { ok: false, status: 400, error: "A context check needs a skill" };
			if (!ctx.skillStates.has(skillId)) return { ok: false, status: 409, error: "Learn this skill first — a context check is for skills you already have" };
			ids = [skillId];
			break;
	}
	const skills = ids.map((id) => sessionSkill(id, ctx));
	const background =
		mode === "learn" ? (ctx.skills.get(ids[0]!)?.requires ?? []).filter((r) => ctx.skills.has(r)).map((r) => sessionSkill(r, ctx)) : [];
	const learnChats = learnChatsBySkill();
	const propIds = [...new Set(ids.flatMap((id) => skillPropositionIds(ctx.skills.get(id)!, ctx, learnChats)))].slice(0, 64);
	const byId = new Map(ctx.graph.nodes.map((n) => [n.id, n]));
	const picked = propIds.map((id) => byId.get(id)!).filter(Boolean);
	const chains = chainsForSelection(picked, ctx.graph.chains).map((c) => formatChainLine(c, Object.fromEntries(byId)));
	const link: ChatCourseLink = { courseId, mode, skillIds: ids };
	const title = courseSessionTitle(mode, course.title, skills);
	// Learn and the placement test are conversation sessions (the teacher;
	// the placement tester); practice and review are practice sessions.
	const chat = stores.chatStore.createChat(title, mode === "learn" || mode === "placement" ? undefined : "practice", link);
	// pace: the dialog's pick, else the course's default; absent, stampNewSession falls back to the global default
	const sessionPace = pace ?? course.pace;
	stampNewSession(chat.id, { language: courseLanguage(course), ...(sessionPace ? { pace: sessionPace } : {}), learnerProfile: mode !== "placement" });
	stores.chatStore.saveMessages(chat.id, [
		newCourseContextMessage({
			courseTitle: course.title,
			mode,
			skills,
			background,
			propositions: picked.map((n) => ({ id: n.id, name: n.name, statement: n.statement })),
			chains,
		}),
	]);
	// a course's activity order follows its sessions
	stores.courseStore.updateCourse(courseId, {});
	return { ok: true, value: { id: chat.id, title: chat.title, prompt: courseFirstMessage(mode, course.title, skills, courseLanguage(course)) } };
}

/** A review or practice course session's course and skills (id + name), for
 *  the tutor's "Learn <skill>" buttons on a concluded problem. Null for any
 *  other session, or when the chat is unknown. */
export function courseSessionSkillNames(chatId: string): { courseId: string; skills: Array<{ id: string; name: string }> } | null {
	const link = stores.chatStore.getChat(chatId)?.course;
	if (!link || (link.mode !== "review" && link.mode !== "practice")) return null;
	const ctx = readContext();
	const skills = link.skillIds.filter((id) => ctx.skills.has(id)).map((id) => ({ id, name: ctx.skills.get(id)!.name }));
	return { courseId: link.courseId, skills };
}

/** A course session's per-turn pieces: the prompt section, its mode, and
 *  (practice modes, the placement test) the skills its question/problem
 *  tool may tag. Undefined for other sessions, or when the course is gone. */
export function courseForTurn(
	chatId: string,
): { section: string; mode: CourseMode; note?: string; skills?: () => ReadonlyArray<{ id: string; name: string }>; lessonSkill?: { id: string; name: string } } | undefined {
	const link = stores.chatStore.getChat(chatId)?.course;
	if (!link) return undefined;
	const course = stores.courseStore.getCourse(link.courseId);
	const ctx = readContext();
	const skills = link.skillIds.filter((id) => ctx.skills.has(id)).map((id) => sessionSkill(id, ctx));
	const section = coursePromptSection(link.mode, course?.title ?? "(deleted course)", skills);
	// The course's time note is read fresh every turn, so editing it reaches the sessions already running.
	const note = course?.note;
	// a lesson's one skill: the final problem is graded for it (core/final-problem.ts)
	const lessonSkill = skills[0] ? { id: skills[0].id, name: skills[0].name } : undefined;
	if (link.mode === "learn") return { section, mode: link.mode, ...(note ? { note } : {}), ...(lessonSkill ? { lessonSkill } : {}) };
	const tags = skills.map((s) => ({ id: s.id, name: s.name }));
	return { section, mode: link.mode, ...(note ? { note } : {}), skills: () => tags };
}
