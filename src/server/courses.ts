import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
	ChatCourseLink,
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
} from "../core/contracts.ts";
import { approveDraft, draftProblems, type DraftCheckContext } from "../core/course-draft.ts";
import {
	courseFirstMessage,
	coursePromptSection,
	courseSessionTitle,
	newCourseContextMessage,
	type SessionSkill,
} from "../core/course-session.ts";
import { chainsForSelection, formatChainLine } from "../core/chains.ts";
import { getGraph } from "../core/graph.ts";
import {
	dueAt,
	foldBoxes,
	inCourseEvidence,
	isDue,
	KNOWN_BOX,
	LEARNED_BOX,
	partitionSkills,
	skillEventsOf,
	type BoxState,
	type SkillEvent,
	type SkillPartition,
} from "../core/mastery.ts";
import { materialBlock } from "../core/materials.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { mergeSkillLines } from "../core/skills.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { draftCourse } from "../agent/subagents/course-planner.ts";
import { callUsage } from "../agent/subagents/extraction.ts";
import { withBgLlmSlot } from "../agent/subagents/bg-llm-semaphore.ts";
import { materialTools } from "../agent/tools/materials.ts";
import { auditorGraphTools } from "../agent/tools/graph.ts";
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

/** Every course session's skill evidence, by course. */
function eventsByCourse(): Map<string, SkillEvent[]> {
	const out = new Map<string, SkillEvent[]>();
	for (const chat of courseChats()) {
		const id = chat!.course!.courseId;
		out.set(id, [...(out.get(id) ?? []), ...skillEventsOf(chat!.messages, chat!.course!)]);
	}
	return out;
}

interface ReadContext {
	graph: ReturnType<typeof getGraph>;
	nodeIds: Set<string>;
	skills: Map<string, Skill>;
	/** A skill's box is global: evidence from every course counts. */
	boxes: Map<string, BoxState>;
	byCourse: Map<string, SkillEvent[]>;
	now: number;
}

function readContext(): ReadContext {
	const graph = getGraph(stores.graphStore);
	const nodeIds = new Set(graph.nodes.map((n) => n.id));
	const skills = allSkills(nodeIds);
	const byCourse = eventsByCourse();
	const boxes = foldBoxes([...byCourse.values()].flat(), (id) => skills.get(id)?.requires ?? []);
	return { graph, nodeIds, skills, boxes, byCourse, now: Date.now() };
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
	return partitionSkills(course.skills, ctx.skills, ctx.boxes, ctx.now, inCourse);
}

export function listCourseSummaries(): CourseSummary[] {
	const courses = stores.courseStore.listCourses();
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
			due: p.review.length,
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
	for (const [id, state] of ctx.boxes) {
		const skill = ctx.skills.get(id);
		if (!skill || state.box < LEARNED_BOX) continue;
		nodes.push({
			id,
			name: skill.name,
			statement: skill.statement,
			box: state.box,
			known: state.box >= KNOWN_BOX,
			due: isDue(state, ctx.now),
			courses: coursesOf.get(id) ?? [],
			propositions: skillPropositionIds(skill, ctx, learnChats),
		});
	}
	if (nodes.length === 0) return undefined;
	nodes.sort((a, b) => b.box - a.box || a.name.localeCompare(b.name));
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

export function courseView(courseId: string): CourseView | null {
	const course = stores.courseStore.getCourse(courseId);
	if (!course) return null;
	const ctx = readContext();
	const p = partitionOf(course, ctx);
	const learnChats = learnChatsBySkill();
	const titles = new Map(stores.chatStore.listChats().map((c) => [c.id, c.title]));
	const nodes = new Map(ctx.graph.nodes.map((n) => [n.id, n]));
	const skills: CourseSkillView[] = p.order.map((id) => {
		const skill = ctx.skills.get(id)!;
		const s = p.states.get(id)!;
		const due = dueAt(s.state);
		return {
			id,
			name: skill.name,
			statement: skill.statement,
			requires: skill.requires.filter((r) => ctx.skills.has(r)),
			box: s.state.box,
			learned: s.learned,
			known: s.known,
			due: s.due,
			dueAt: due === null ? null : new Date(due).toISOString(),
			missing: s.missing,
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
		nextUp: p.nextUp,
		learning: p.learning,
		locked: p.locked,
		known: p.known,
		contextCheck: p.contextCheck,
		sessions,
		reused,
	};
}

// ─── create / rename / delete ────────────────────────────────────────────────

export function createCourse(title: string): CourseRecord {
	return stores.courseStore.createCourse(title);
}

export function renameCourse(courseId: string, title: string): CourseRecord | null {
	return stores.courseStore.updateCourse(courseId, { title: title.trim() || "Untitled course" });
}

/** Delete a course: its record and its material. Its skills stay in the
 *  graph (shared, with their history); its sessions stay, unlabelled. */
export function deleteCourse(courseId: string): boolean {
	if (!stores.courseStore.getCourse(courseId)) return false;
	draftRuns().get(courseId)?.abort();
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

/** Is a drafting run live for this course? */
export function courseDrafting(courseId: string): boolean {
	return draftRuns().has(courseId);
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
			...auditorGraphTools({ chatStore: stores.chatStore, graphStore: stores.graphStore }),
		};
		const result = await withBgLlmSlot(controller.signal, () =>
			draftCourse(
				{
					title: course.title,
					materials: materials.map((m) => ({ id: m.id, name: m.name })),
					materialsSection,
					...(feedback && course.draft ? { previous: { draft: course.draft, feedback } } : {}),
					...(approved.length > 0 ? { approved } : {}),
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
			),
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
	const state = ctx.boxes.get(id) ?? { box: 0, lastMove: null };
	return { id, name: skill.name, statement: skill.statement, box: state.box, known: state.box >= KNOWN_BOX };
}

/** Create a session from a course (docs/courses.md §4). The client sends
 *  `prompt` as the first learner message. */
export function createCourseSession(
	courseId: string,
	mode: CourseMode,
	skillId?: string,
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
			ids = p.review;
			if (ids.length === 0) return { ok: false, status: 409, error: "Nothing is due for review" };
			break;
		case "placement":
			// skills already had from another course get their own context
			// check — the placement test does not spend questions on them
			ids = p.order.filter((id) => !p.contextCheck.includes(id));
			if (ids.length === 0) return { ok: false, status: 409, error: "Every skill is already known from another course — use the context checks" };
			break;
		case "check":
			if (skillId === undefined) return { ok: false, status: 400, error: "A context check needs a skill" };
			if ((ctx.boxes.get(skillId)?.box ?? 0) < LEARNED_BOX) return { ok: false, status: 409, error: "Learn this skill first — a context check is for skills you already have" };
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
	stampNewSession(chat.id);
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
	return { ok: true, value: { id: chat.id, title: chat.title, prompt: courseFirstMessage(mode, course.title, skills) } };
}

/** A course session's per-turn pieces: the prompt section, its mode, and
 *  (practice modes, the placement test) the skills its question/problem
 *  tool may tag. Undefined for other sessions, or when the course is gone. */
export function courseForTurn(
	chatId: string,
): { section: string; mode: CourseMode; skills?: () => ReadonlyArray<{ id: string; name: string }> } | undefined {
	const link = stores.chatStore.getChat(chatId)?.course;
	if (!link) return undefined;
	const course = stores.courseStore.getCourse(link.courseId);
	const ctx = readContext();
	const skills = link.skillIds.filter((id) => ctx.skills.has(id)).map((id) => sessionSkill(id, ctx));
	const section = coursePromptSection(link.mode, course?.title ?? "(deleted course)", skills);
	if (link.mode === "learn") return { section, mode: link.mode };
	const tags = skills.map((s) => ({ id: s.id, name: s.name }));
	return { section, mode: link.mode, skills: () => tags };
}
