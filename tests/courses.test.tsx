/**
 * Courses (fork addition, 2026-10-24 — docs/courses.md): skills in the
 * graph, the Leitner stand-in for "known", draft checks + approval, the
 * course-session pieces, the stores, the service seam, the practice tool's
 * skill tags, the planner against a scripted model, and the UI's render.
 * Deterministic: no network, no real model; LH_DATA_DIR isolates.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-courses-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { mergeSkillLines, prerequisiteClosure, topoOrder } = await import("../src/core/skills.ts");
const mastery = await import("../src/core/mastery.ts");
const { approveDraft, draftProblems, uncitedMaterials } = await import("../src/core/course-draft.ts");
const session = await import("../src/core/course-session.ts");
const { skillStore } = await import("../src/store/skills.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { materialStore } = await import("../src/store/materials.ts");
const { subscribe } = await import("../src/core/events.ts");
const courses = await import("../src/server/courses.ts");
const { sessionMaterials } = await import("../src/server/materials.ts");
const { practiceTools, problemTool } = await import("../src/agent/tools/practice.ts");
const { draftCourse } = await import("../src/agent/subagents/course-planner.ts");
const { CourseRow, courseMeta } = await import("../components/courses-section.tsx");
const { CourseBody, courseProgress, skillStateLabel } = await import("../components/course-page.tsx");
const { GraphContextCard } = await import("../components/graph-context-card.tsx");
const { LEDGER_FILES, PATHS } = await import("../config.ts");

import type { ChatCourseLink, CourseDraft, GraphNode, Skill, SkillLine } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { CoursePayload } from "../components/course-page.tsx";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");

const line = (id: string, requires: string[] = [], restsOn: string[] = [], name = id): SkillLine => ({
	id,
	name,
	statement: `Do ${name}`,
	requires,
	restsOn,
	createdAt: "2026-10-01T00:00:00Z",
});

// ─── message builders (native records) ──────────────────────────────────────

let seq = 0;
function assistant(calls: Array<{ id: string; name: string; args: unknown }>, at: number): LhMessage {
	return {
		id: `m${++seq}`,
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args })),
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: at,
	} as unknown as LhMessage;
}
function result(toolCallId: string, toolName: string, at: number, isError = false): LhMessage {
	return { id: `m${++seq}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], isError, timestamp: at } as unknown as LhMessage;
}
/** One posed-and-concluded problem on the given skills. */
function problem(skills: string[], outcome: string, at: number, opts: { poseError?: boolean } = {}): LhMessage[] {
	const p = `p${++seq}`;
	const c = `c${++seq}`;
	return [
		assistant([{ id: p, name: "problem", args: { statement: "S", mode: "recall", modelSolution: "M", skills } }], at),
		result(p, "problem", at, opts.poseError),
		assistant([{ id: c, name: "conclude", args: { outcome, verdict: "v", rung: null, missClass: null, retest: false } }], at + 1),
		result(c, "conclude", at + 1),
	];
}

const practiceLink = (skillIds: string[], mode: ChatCourseLink["mode"] = "practice"): ChatCourseLink => ({ courseId: "course_x", mode, skillIds });

// ─── skills ──────────────────────────────────────────────────────────────────

describe("skills (core/skills.ts)", () => {
	it("merges lines by id: the first line defines, later lines union their edges", () => {
		const merged = mergeSkillLines([
			line("a"),
			line("b", ["a"], ["n1"]),
			{ ...line("b", ["c"], ["n2"]), name: "renamed" },
			line("c"),
		]);
		const b = merged.find((s) => s.id === "b")!;
		assert.equal(b.name, "b", "the first line's name stands");
		assert.deepEqual(b.requires, ["a", "c"]);
		assert.deepEqual(b.restsOn, ["n1", "n2"]);
		assert.deepEqual(merged.map((s) => s.id), ["a", "b", "c"]);
	});

	it("drops unknown skills, self-edges and dead propositions at read", () => {
		const merged = mergeSkillLines([line("a", ["a", "ghost"], ["n1", "dead"])], new Set(["n1"]));
		assert.deepEqual(merged[0]!.requires, []);
		assert.deepEqual(merged[0]!.restsOn, ["n1"]);
	});

	it("closure and topological order (prerequisites first; cycles are null)", () => {
		const req: Record<string, string[]> = { d: ["b", "c"], b: ["a"], c: ["a"], a: [] };
		assert.deepEqual([...prerequisiteClosure("d", (id) => req[id] ?? [])].sort(), ["a", "b", "c"]);
		assert.deepEqual(topoOrder(["d", "c", "b", "a"], (id) => req[id] ?? []), ["a", "c", "b", "d"]);
		assert.equal(topoOrder(["x", "y"], (id) => (id === "x" ? ["y"] : ["x"])), null);
	});
});

// ─── the Leitner stand-in ────────────────────────────────────────────────────

describe("known — the box fold (core/mastery.ts)", () => {
	const none = () => [];

	it("reads skill events from cleanly concluded problems only", () => {
		const messages = [
			...problem(["a"], "solved", T0),
			...problem(["b"], "solved", T0 + 10, { poseError: true }), // a refused pose never happened
			...problem(["a", "a", "c"], "movedOn", T0 + 20),
		];
		const events = mastery.skillEventsOf(messages, practiceLink(["a", "b", "c"]));
		assert.deepEqual(
			events.map((e) => [e.skillId, e.outcome]),
			[
				["a", "solved"],
				["a", "movedOn"],
				["c", "movedOn"],
			],
		);
		assert.equal(events[0]!.at, T0 + 1, "the conclude's timestamp");
		assert.deepEqual(mastery.skillEventsOf(messages, practiceLink(["a"], "learn")), [], "Learn sessions carry no box evidence");
	});

	it("a dismissal ends the active problem without an outcome", () => {
		const p = `p${++seq}`;
		const messages = [
			assistant([{ id: p, name: "problem", args: { skills: ["a"] } }], T0),
			result(p, "problem", T0),
			{ id: "d", role: "custom", customType: "problem-dismissed", content: "", display: true, details: {}, timestamp: T0 + 1 } as unknown as LhMessage,
		];
		assert.deepEqual(mastery.skillEventsOf(messages, practiceLink(["a"])), []);
	});

	it("a clean solve promotes only when due; hints stay; misses reset to box 1", () => {
		const ev = (outcome: string, at: number) => ({ skillId: "a", outcome: outcome as never, at, placement: false });
		const boxAfter = (...events: ReturnType<typeof ev>[]) => mastery.foldBoxes(events, none).get("a")!.box;
		assert.equal(boxAfter(ev("solved", T0)), 1, "box 0 is always due");
		assert.equal(boxAfter(ev("solved", T0), ev("solved", T0 + 1000)), 1, "box 1 is not due for a day");
		assert.equal(boxAfter(ev("solved", T0), ev("solved", T0 + DAY)), 2);
		assert.equal(boxAfter(ev("solved", T0), ev("solved", T0 + DAY), ev("solved", T0 + 4 * DAY)), 3, "known after three spaced solves");
		assert.equal(boxAfter(ev("solved", T0), ev("solvedWithHints", T0 + 5 * DAY)), 1, "with hints: nothing");
		assert.equal(boxAfter(ev("solved", T0), ev("solved", T0 + DAY), ev("surrendered", T0 + DAY + 5)), 1);
		assert.equal(boxAfter(ev("movedOn", T0)), 1, "a miss on box 0 still lands in box 1");
		assert.equal(mastery.foldBoxes([ev("dismissed", T0)], none).get("a"), undefined, "dismissed is ignored");
		// events arrive in any order
		assert.equal(boxAfter(ev("solved", T0 + DAY), ev("solved", T0)), 2);
		// capped at box 5
		let at = T0;
		const many = [];
		for (let i = 0; i < 8; i++) {
			many.push(ev("solved", at));
			at += 40 * DAY;
		}
		assert.equal(boxAfter(...many), mastery.MAX_BOX);
	});

	it("placement: a clean solve credits the skill and every transitive prerequisite to box 3", () => {
		const req: Record<string, string[]> = { c: ["b"], b: ["a"], a: [] };
		const boxes = mastery.foldBoxes(
			[
				{ skillId: "a", outcome: "solved", at: T0, placement: false },
				{ skillId: "a", outcome: "solved", at: T0 + DAY, placement: false },
				{ skillId: "a", outcome: "solved", at: T0 + 4 * DAY, placement: false },
				{ skillId: "a", outcome: "solved", at: T0 + 11 * DAY, placement: false }, // box 4
				{ skillId: "c", outcome: "solved", at: T0 + 12 * DAY, placement: true },
			],
			(id) => req[id] ?? [],
		);
		assert.equal(boxes.get("c")!.box, 3);
		assert.equal(boxes.get("b")!.box, 3);
		assert.equal(boxes.get("a")!.box, 4, "never lowered");
	});

	it("placement: with hints → at least box 1; a miss → box 1", () => {
		const boxes = mastery.foldBoxes(
			[
				{ skillId: "x", outcome: "solvedWithHints", at: T0, placement: true },
				{ skillId: "y", outcome: "surrendered", at: T0, placement: true },
			],
			none,
		);
		assert.equal(boxes.get("x")!.box, 1);
		assert.equal(boxes.get("y")!.box, 1);
	});

	it("due dates follow the box intervals", () => {
		assert.equal(mastery.isDue({ box: 0, lastMove: null }, T0), true);
		assert.equal(mastery.dueAt({ box: 0, lastMove: null }), null);
		assert.equal(mastery.dueAt({ box: 3, lastMove: T0 }), T0 + 7 * DAY);
		assert.equal(mastery.isDue({ box: 3, lastMove: T0 }, T0 + 7 * DAY - 1), false);
		assert.equal(mastery.isDue({ box: 3, lastMove: T0 }, T0 + 7 * DAY), true);
	});

	it("partitions a course: review, next up, locked (with what is missing), known", () => {
		const skills = new Map<string, Skill>(mergeSkillLines([line("a"), line("b", ["a"]), line("c", ["b"]), line("d")]).map((s) => [s.id, s]));
		const boxes = new Map([
			["a", { box: 3, lastMove: T0 }],
			["d", { box: 1, lastMove: T0 }],
		]);
		const p = mastery.partitionSkills(["c", "b", "a", "d", "ghost"], skills, boxes, T0 + 2 * DAY);
		assert.deepEqual(p.order, ["b", "a", "d", "c"].sort((x, y) => p.order.indexOf(x) - p.order.indexOf(y)));
		assert.ok(p.order.indexOf("a") < p.order.indexOf("b") && p.order.indexOf("b") < p.order.indexOf("c"), "prerequisites first");
		assert.deepEqual(p.known, ["a"]);
		assert.deepEqual(p.nextUp.sort(), ["b", "d"]);
		assert.deepEqual(p.locked, ["c"]);
		assert.deepEqual(p.states.get("c")!.missing, ["b"]);
		assert.deepEqual(p.review, ["d"], "box ≥ 1 and due (a is known but not due for 7 days)");
	});
});

// ─── drafts ──────────────────────────────────────────────────────────────────

describe("drafts (core/course-draft.ts)", () => {
	const existing = new Map<string, Skill>([["sk_old", { ...line("sk_old", [], ["n1"]), name: "Old" }]]);
	const ctx = { skills: existing, nodeIds: new Set(["n1", "n2"]) };
	const ds = (key: string, over: Partial<CourseDraft["skills"][number]> = {}) => ({
		key,
		name: key.toUpperCase(),
		statement: `Do ${key}`,
		requires: [] as string[],
		restsOn: [] as string[],
		...over,
	});

	it("accepts a valid draft and names every problem otherwise", () => {
		assert.deepEqual(draftProblems([ds("s1"), ds("s2", { requires: ["s1"], restsOn: ["n2"] }), ds("s3", { reuse: "sk_old" })], ctx), []);
		assert.deepEqual(draftProblems([], ctx), ["the draft has no skills"]);
		const problems = draftProblems(
			[
				ds("s1", { requires: ["s1", "nope"], restsOn: ["ghost"], reuse: "sk_missing" }),
				ds("s1", { name: " " }),
				ds("s2", { reuse: "sk_old" }),
				ds("s3", { reuse: "sk_old" }),
			],
			ctx,
		);
		const text = problems.join("\n");
		for (const re of [/duplicate key "s1"/, /empty name/, /not an existing skill id/, /both reuse sk_old/, /not an existing proposition id/, /requires itself/, /"nope" is not a key/]) {
			assert.match(text, re);
		}
		assert.match(draftProblems([ds("s1", { requires: ["s2"] }), ds("s2", { requires: ["s1"] })], ctx).join(), /cycle/);
	});

	it("checks that every material is cited", () => {
		assert.deepEqual(uncitedMaterials([ds("s1", { cite: "Calculus.pdf, p. 3" })], [{ id: "mat_1", name: "Calculus.pdf" }, { id: "mat_2", name: "Notes.md" }]), ["Notes.md"]);
	});

	it("approval mints new skills, link-appends only new edges to reused ones, and pulls in their prerequisites", () => {
		const skills = new Map<string, Skill>([
			["sk_base", line("sk_base")],
			["sk_old", line("sk_old", ["sk_base"], ["n1"])],
		]);
		let n = 0;
		const draft: CourseDraft = {
			createdAt: "t",
			summary: "s",
			skills: [ds("s1", { reuse: "sk_old", restsOn: ["n1", "n2"] }), ds("s2", { requires: ["s1"] })],
		};
		const out = approveDraft(draft, { skills, nodeIds: new Set(["n1", "n2"]) }, () => `sk_new${++n}`, "2026-10-24T00:00:00Z");
		assert.deepEqual(
			out.lines.map((l) => [l.id, l.requires, l.restsOn]),
			[
				["sk_old", [], ["n2"]],
				["sk_new1", ["sk_old"], []],
			],
		);
		assert.equal(out.lines[0]!.name, "sk_old", "a reused skill keeps its own name");
		assert.deepEqual(out.skillIds.sort(), ["sk_base", "sk_new1", "sk_old"], "the reused skill's prerequisite joins the course");
		const again = approveDraft({ ...draft, skills: [ds("s1", { reuse: "sk_old", restsOn: ["n1"] })] }, { skills, nodeIds: new Set(["n1"]) }, () => "x", "t");
		assert.deepEqual(again.lines, [], "nothing new → nothing written");
	});
});

// ─── course sessions (pure) ──────────────────────────────────────────────────

describe("course sessions (core/course-session.ts)", () => {
	const sk = (id: string, box = 0) => ({ id, name: id.toUpperCase(), statement: `Do ${id}`, box, known: box >= 3 });

	it("the context marker carries skills, prerequisites, propositions and chains — as a graph-context marker", () => {
		const m = session.newCourseContextMessage({
			courseTitle: "Calc",
			mode: "learn",
			skills: [sk("sk_b", 1)],
			background: [sk("sk_a", 4)],
			propositions: [{ id: "n1", name: "Chain rule", statement: "(f∘g)' = f'(g)·g'" }],
			chains: ["A → B"],
		});
		assert.equal(m.customType, "graph-context");
		assert.match(m.content, /course "Calc" \(Learn\)/);
		assert.match(m.content, /\[sk_b\] SK_B: Do sk_b · learning \(box 1 of 5\)/);
		assert.match(m.content, /prerequisite skills[\s\S]*\[sk_a\] SK_A: Do sk_a · known \(box 4 of 5\)/);
		assert.match(m.content, /\[n1\] Chain rule/);
		assert.match(m.content, /- A → B/);
		const details = m.details as { course: { title: string; mode: string; skills: unknown[] }; propositions: unknown[] };
		assert.equal(details.course.mode, "learn");
		assert.equal(details.course.skills.length, 1);
		assert.equal(details.propositions.length, 1);
	});

	it("titles and first messages per mode", () => {
		assert.equal(session.courseSessionTitle("learn", "Calc", [{ name: "Chain rule" }]), "Learn: Chain rule");
		assert.equal(session.courseSessionTitle("practice", "Calc", [{ name: "A" }, { name: "B" }]), "Practice: A, B");
		assert.equal(session.courseSessionTitle("review", "Calc", []), "Review: Calc");
		assert.equal(session.courseSessionTitle("placement", "Calc", []), "Placement: Calc");
		assert.equal(session.courseFirstMessage("learn", "Calc", [{ name: "A", statement: "Do a" }]), "I want to learn to: Do a");
		assert.equal(session.courseFirstMessage("placement", "Calc", []), "Placement check for Calc");
	});

	it("the prompt section: Learn targets one skill; practice modes carry the tagging law", () => {
		const learn = session.coursePromptSection("learn", "Calc", [sk("sk_a")]);
		assert.match(learn, /^<course>\n/);
		assert.match(learn, /ONE skill/);
		assert.match(learn, /SK_A: Do sk_a/);
		assert.doesNotMatch(learn, /`skills` field/);
		for (const mode of ["practice", "review", "placement"] as const) {
			assert.match(session.coursePromptSection(mode, "Calc", [sk("sk_a")]), /`skills` field MUST name them/);
		}
		assert.match(session.coursePromptSection("placement", "Calc", []), /PLACEMENT CHECK[\s\S]*most advanced skills/);
		assert.match(session.coursePromptSection("review", "Calc", []), /due for review/);
	});
});

// ─── stores ──────────────────────────────────────────────────────────────────

describe("the stores", () => {
	it("skills.jsonl appends in order and skips corrupt lines", () => {
		skillStore.appendSkillLines([line("sk_s1"), line("sk_s2", ["sk_s1"])]);
		fs.appendFileSync(LEDGER_FILES.skills, "{torn\n");
		skillStore.appendSkillLines([]);
		const read = skillStore.readSkillLines().filter((l) => l.id.startsWith("sk_s"));
		assert.deepEqual(read.map((l) => l.id), ["sk_s1", "sk_s2"]);
		fs.writeFileSync(LEDGER_FILES.skills, ""); // leave the ledger empty for the service tests
	});

	it("course records: create, update (undefined clears), list newest first, delete — each announced", () => {
		let announced = 0;
		const off = subscribe((e) => {
			if (e.type === "courses-changed") announced++;
		});
		const a = courseStore.createCourse("  ");
		assert.equal(a.title, "Untitled course");
		assert.equal(a.status, "new");
		assert.match(a.id, /^course_/);
		const updated = courseStore.updateCourse(a.id, { error: "boom", status: "error" })!;
		assert.equal(updated.error, "boom");
		const cleared = courseStore.updateCourse(a.id, { error: undefined })!;
		assert.equal("error" in cleared, false);
		assert.equal(courseStore.getCourse(a.id)!.version, 1);
		assert.ok(courseStore.listCourses().some((c) => c.id === a.id));
		assert.equal(courseStore.deleteCourse(a.id), true);
		assert.equal(courseStore.deleteCourse(a.id), false);
		assert.equal(courseStore.getCourse(a.id), null);
		off();
		assert.equal(announced, 4);
	});

	it("a newer-stamped course record is refused", () => {
		fs.mkdirSync(PATHS.courses, { recursive: true });
		fs.writeFileSync(path.join(PATHS.courses, "course_future.json"), JSON.stringify({ id: "course_future", version: 99 }));
		assert.equal(courseStore.getCourse("course_future"), null);
		fs.rmSync(path.join(PATHS.courses, "course_future.json"));
	});

	it("a chat is born with its course link, and the summary carries it", () => {
		const chat = chatStore.createChat("x", "practice", practiceLink(["a"]));
		assert.deepEqual(chatStore.getChat(chat.id)!.course, practiceLink(["a"]));
		assert.deepEqual(chatStore.listChats().find((c) => c.id === chat.id)!.course, practiceLink(["a"]));
		chatStore.deleteChat(chat.id);
	});
});

// ─── the service seam ────────────────────────────────────────────────────────

function node(id: string, name: string, chatId = "src_notes"): GraphNode {
	return { id, name, statement: `${name} holds`, aliases: [], createdAt: "2026-10-01T00:00:00Z", provenance: [{ chatId, messageId: "" }] };
}

describe("the course service (src/server/courses.ts)", () => {
	beforeEach(() => {
		for (const c of courseStore.listCourses()) courseStore.deleteCourse(c.id);
		for (const c of chatStore.listChats()) chatStore.deleteChat(c.id);
		fs.rmSync(LEDGER_FILES.skills, { force: true });
		fs.rmSync(LEDGER_FILES.nodes, { force: true });
	});

	/** An approved course a → b → c (b rests on n1). */
	function approvedCourse() {
		graphStore.appendNode(node("n1", "Power rule"));
		const course = courseStore.createCourse("Calc");
		courseStore.updateCourse(course.id, {
			status: "draft",
			draft: {
				createdAt: "t",
				summary: "s",
				skills: [
					{ key: "s1", name: "A", statement: "Do a", requires: [], restsOn: [] },
					{ key: "s2", name: "B", statement: "Do b", requires: ["s1"], restsOn: ["n1"] },
					{ key: "s3", name: "C", statement: "Do c", requires: ["s2"], restsOn: [] },
				],
			},
		});
		const approved = courses.approveCourse(course.id);
		assert.ok(approved.ok);
		const ids = approved.value.skills;
		const byName = Object.fromEntries(mergeSkillLines(skillStore.readSkillLines()).map((s) => [s.name, s.id]));
		return { courseId: course.id, ids, a: byName.A!, b: byName.B!, c: byName.C! };
	}

	it("approval writes the ledger, clears the draft and activates the course", () => {
		const { courseId, ids, a, b } = approvedCourse();
		assert.equal(ids.length, 3);
		const record = courseStore.getCourse(courseId)!;
		assert.equal(record.status, "active");
		assert.equal(record.draft, undefined);
		const skills = mergeSkillLines(skillStore.readSkillLines());
		assert.deepEqual(skills.find((s) => s.id === b)!.requires, [a]);
		assert.deepEqual(skills.find((s) => s.id === b)!.restsOn, ["n1"]);
		assert.equal(courses.approveCourse(courseId).ok, false, "no draft left to approve");
	});

	it("approval refuses a draft that no longer fits the graph", () => {
		const course = courseStore.createCourse("X");
		courseStore.updateCourse(course.id, {
			draft: { createdAt: "t", summary: "s", skills: [{ key: "s1", name: "A", statement: "a", requires: [], restsOn: ["n_gone"] }] },
		});
		const out = courses.approveCourse(course.id);
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.status, 422);
	});

	it("the view: a fresh course has a as next up and b, c locked", () => {
		const { courseId, a, b, c } = approvedCourse();
		const view = courses.courseView(courseId)!;
		assert.deepEqual(view.skills.map((s) => s.id), [a, b, c]);
		assert.deepEqual(view.nextUp, [a]);
		assert.deepEqual(view.locked, [b, c]);
		assert.deepEqual(view.skills.find((s) => s.id === b)!.missing, [a]);
		assert.deepEqual(view.skills.find((s) => s.id === b)!.propositions.map((p) => p.id), ["n1"]);
		assert.deepEqual(courses.listCourseSummaries().map((s) => [s.title, s.known, s.total]), [["Calc", 0, 3]]);
	});

	it("sessions: refusals per mode, then a Learn session born with link, marker and stamp", () => {
		const { courseId, a, b } = approvedCourse();
		assert.equal(courses.createCourseSession(courseId, "learn").ok, false, "Learn needs a skill");
		const review = courses.createCourseSession(courseId, "review");
		assert.ok(!review.ok && review.status === 409, "nothing is due");
		assert.equal(courses.createCourseSession(courseId, "learn", "sk_elsewhere").ok, false);
		const learn = courses.createCourseSession(courseId, "learn", b);
		assert.ok(learn.ok);
		assert.equal(learn.value.title, "Learn: B");
		assert.equal(learn.value.prompt, "I want to learn to: Do b");
		const record = chatStore.getChat(learn.value.id)!;
		assert.equal(record.kind, undefined, "Learn is a teach session");
		assert.deepEqual(record.course, { courseId, mode: "learn", skillIds: [b] });
		assert.equal(record.messages.length, 1);
		const marker = record.messages[0] as unknown as { customType: string; content: string };
		assert.equal(marker.customType, "graph-context");
		assert.match(marker.content, new RegExp(`\\[${a}\\] A: Do a`), "the prerequisite rides as background");
		assert.match(marker.content, /\[n1\] Power rule/);
		assert.ok(record.settings?.language, "the birth stamp ran");
	});

	it("practice sessions move boxes; placement credits prerequisites; the route follows", () => {
		const { courseId, a, b, c } = approvedCourse();
		const placement = courses.createCourseSession(courseId, "placement");
		assert.ok(placement.ok);
		const record = chatStore.getChat(placement.value.id)!;
		assert.equal(record.kind, "practice");
		assert.deepEqual(record.course!.skillIds, [a, b, c]);
		// the learner cleanly solves B in placement → A and B are known
		chatStore.saveMessages(placement.value.id, [...record.messages, ...problem([b], "solved", Date.now() - 1000)]);
		const view = courses.courseView(courseId)!;
		assert.deepEqual(view.known, [a, b]);
		assert.deepEqual(view.nextUp, [c]);
		assert.deepEqual(view.locked, []);
		const practice = courses.createCourseSession(courseId, "practice");
		assert.ok(practice.ok);
		assert.deepEqual(chatStore.getChat(practice.value.id)!.course!.skillIds, [c], "practice all = next up");
	});

	it("propositions extracted from a Learn session rest on its skill (derived)", () => {
		const { courseId, c } = approvedCourse();
		const learn = courses.createCourseSession(courseId, "learn", c);
		assert.ok(learn.ok);
		graphStore.appendNode(node("n2", "Quotient rule", learn.value.id));
		const view = courses.courseView(courseId)!;
		const props = view.skills.find((s) => s.id === c)!.propositions;
		assert.deepEqual(props.map((p) => p.id), ["n2"]);
		assert.deepEqual(props[0]!.sessions, [{ id: learn.value.id, title: "Learn: C" }]);
	});

	it("each turn: Learn gets the section only; practice modes get the taggable skills", () => {
		const { courseId, a } = approvedCourse();
		const learn = courses.createCourseSession(courseId, "learn", a);
		const practice = courses.createCourseSession(courseId, "practice", a);
		assert.ok(learn.ok && practice.ok);
		const l = courses.courseForTurn(learn.value.id)!;
		assert.match(l.section, /ONE skill/);
		assert.equal(l.skills, undefined);
		const p = courses.courseForTurn(practice.value.id)!;
		assert.deepEqual(p.skills!(), [{ id: a, name: "A" }]);
		const plain = chatStore.createChat("plain");
		assert.equal(courses.courseForTurn(plain.id), undefined);
	});

	it("drafting refuses without curriculum, and a change request needs a draft", () => {
		const course = courseStore.createCourse("Empty");
		const none = courses.startCourseDraft(course.id);
		assert.ok(!none.ok && none.status === 400);
		materialStore.add(course.id, { kind: "text", name: "c.md", ext: ".md", bytes: new TextEncoder().encode("# C") });
		materialStore.update(course.id, materialStore.list(course.id)[0]!.id, { status: "ready", profile: "P" });
		const feedback = courses.startCourseDraft(course.id, "split it");
		assert.ok(!feedback.ok && feedback.status === 400);
		assert.ok(!courses.startCourseDraft("course_nope").ok);
	});

	it("a course session sees its course's material beside its own", () => {
		const { courseId, a } = approvedCourse();
		const cm = materialStore.add(courseId, { kind: "text", name: "curriculum.md", ext: ".md", bytes: new TextEncoder().encode("# Curriculum") });
		const learn = courses.createCourseSession(courseId, "learn", a);
		assert.ok(learn.ok);
		const lm = materialStore.add(learn.value.id, { kind: "text", name: "mine.md", ext: ".md", bytes: new TextEncoder().encode("# Mine") });
		const store = sessionMaterials(learn.value.id);
		assert.deepEqual(store.list(learn.value.id).map((m) => m.name).sort(), ["curriculum.md", "mine.md"]);
		assert.equal(fs.readFileSync(store.filePath(learn.value.id, cm), "utf8"), "# Curriculum");
		assert.equal(fs.readFileSync(store.filePath(learn.value.id, lm), "utf8"), "# Mine");
	});

	it("deleting a course keeps its skills and sessions", () => {
		const { courseId, a } = approvedCourse();
		const learn = courses.createCourseSession(courseId, "learn", a);
		assert.ok(learn.ok);
		assert.equal(courses.deleteCourse(courseId), true);
		assert.equal(courseStore.getCourse(courseId), null);
		assert.equal(mergeSkillLines(skillStore.readSkillLines()).length, 3);
		assert.ok(chatStore.getChat(learn.value.id));
	});
});

// ─── the practice tool's skill tags ──────────────────────────────────────────

describe("the problem tool in a course session", () => {
	const skills = () => [
		{ id: "sk_a", name: "Chain rule" },
		{ id: "sk_b", name: "Product rule" },
	];
	const pose = { statement: "S", mode: "recall", modelSolution: "M" };
	const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join("");

	it("has a skills field only when the session has skills", () => {
		const plain = problemTool({ problemActive: false });
		assert.equal("skills" in (plain.parameters as { properties: object }).properties, false);
		const course = problemTool({ problemActive: false }, undefined, skills);
		assert.equal("skills" in (course.parameters as { properties: object }).properties, true);
	});

	it("normalizes names to ids and rejects missing or foreign skills", async () => {
		const tool = problemTool({ problemActive: false }, undefined, skills);
		const prepared = tool.prepareArguments!({ ...pose, skills: ["chain rule", "sk_b", "sk_b"] }) as unknown as { skills: string[] };
		assert.deepEqual(prepared.skills, ["sk_a", "sk_b"]);
		const missing = await tool.execute("t1", { ...pose } as never);
		assert.match(text(missing), /skills is required/);
		const foreign = await problemTool({ problemActive: false }, undefined, skills).execute("t2", { ...pose, skills: ["sk_z"] } as never);
		assert.match(text(foreign), /not this session's skills/);
		const gate = { problemActive: false };
		const ok = await problemTool(gate, undefined, skills).execute("t3", { ...pose, skills: ["sk_a"] } as never);
		assert.doesNotMatch(text(ok), /not this session|required/);
		assert.equal(gate.problemActive, true);
	});

	it("the registry wires courseSkills through", () => {
		const tools = practiceTools({ chatId: "x", chatStore: { getChat: () => ({ messages: [] }) }, courseSkills: skills });
		assert.equal("skills" in (tools.problem!.parameters as { properties: object }).properties, true);
	});
});

// ─── the planner ─────────────────────────────────────────────────────────────

describe("the course planner (scripted model)", () => {
	function engine(steps: FauxResponseStep[]) {
		const faux = createFauxCore({});
		faux.setResponses(steps);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	}
	const submit = (input: unknown, id: string) => () =>
		fauxAssistantMessage([fauxToolCall("submit_draft", input as ToolCall["arguments"], { id })], { stopReason: "toolUse" });

	it("an invalid draft is sent back; the corrected one is returned", async () => {
		const bad = { summary: "s", skills: [{ key: "s1", name: "A", statement: "Do a", requires: ["s9"], restsOn: [], cite: "Book.pdf" }] };
		const good = { summary: "s", skills: [{ key: "s1", name: "A", statement: "Do a", requires: [], restsOn: [], cite: "Book.pdf, p. 1" }] };
		let steps = 0;
		const out = await draftCourse(
			{ title: "T", materials: [{ id: "mat_1", name: "Book.pdf" }], materialsSection: "<curriculum/>" },
			{
				engine: engine([submit(bad, "c1"), submit(good, "c2")]),
				checkContext: () => ({ skills: new Map(), nodeIds: new Set() }),
				tools: {},
				courseId: "course_t",
				onStep: () => void steps++,
			},
		);
		assert.deepEqual(out.skills.map((s) => [s.key, s.requires]), [["s1", []]]);
		assert.equal(steps, 2);
	});

	it("an uncited material is a validation problem", async () => {
		const uncited = { summary: "s", skills: [{ key: "s1", name: "A", statement: "Do a", requires: [], restsOn: [] }] };
		await assert.rejects(
			draftCourse(
				{ title: "T", materials: [{ id: "mat_1", name: "Book.pdf" }], materialsSection: "" },
				{
					engine: engine([submit(uncited, "c1"), () => fauxAssistantMessage("I give up")]),
					checkContext: () => ({ skills: new Map(), nodeIds: new Set() }),
					tools: {},
					courseId: "course_t",
					onStep: () => {},
				},
			),
			/never submitted/,
		);
	});
});

// ─── render ──────────────────────────────────────────────────────────────────

describe("the UI", () => {
	const summary = { id: "course_a", title: "Calc", status: "active" as const, updatedAt: "t", total: 12, known: 7, due: 2 };

	it("the sidebar row reads known/total, percent and due", () => {
		assert.equal(courseMeta(summary), "7/12 known · 58% · 2 due");
		assert.equal(courseMeta({ ...summary, status: "drafting" }), "Drafting skill map…");
		assert.equal(courseMeta({ ...summary, total: 0, known: 0, due: 0, status: "draft" }), "Draft ready to review");
		const html = renderToStaticMarkup(<CourseRow course={summary} active={false} onOpen={() => {}} />);
		assert.match(html, /Calc/);
		assert.match(html, /7\/12 known/);
	});

	const skillView = (id: string, over: Partial<CoursePayload["skills"][number]> = {}) => ({
		id,
		name: id.toUpperCase(),
		statement: `Do ${id}`,
		requires: [] as string[],
		box: 0,
		known: false,
		due: true,
		dueAt: null,
		missing: [] as string[],
		propositions: [],
		...over,
	});
	const payload = (over: Partial<CoursePayload> = {}): CoursePayload => ({
		course: { id: "course_a", title: "Calc", createdAt: "t", updatedAt: "t", status: "active", skills: ["a", "b"] },
		skills: [skillView("a", { box: 3, known: true, due: false, dueAt: "2099-01-01T00:00:00Z" }), skillView("b", { requires: ["a"] })],
		review: [],
		nextUp: ["b"],
		locked: [],
		known: ["a"],
		sessions: [{ id: "chat_1", title: "Learn: A", mode: "learn", updatedAt: "t" }],
		reused: {},
		drafting: false,
		...over,
	});
	const body = (data: CoursePayload) =>
		renderToStaticMarkup(
			<CourseBody data={data} busy={false} error={null} onDraft={() => {}} onApprove={() => {}} onStart={() => {}} materialCount={1} />,
		);

	it("an active course shows the map, next up with Learn/Practice, known and sessions", () => {
		const html = body(payload());
		assert.match(html, /data-testid="course-map"/);
		assert.match(html, /data-testid="learn-b"/);
		assert.match(html, /data-testid="practice-b"/);
		assert.match(html, /data-testid="course-known"/);
		assert.match(html, /Learn: A/);
		assert.doesNotMatch(html, /course-draft"/);
		assert.equal(courseProgress(payload()), "1/2 known · 50%");
	});

	it("a draft shows its skills, reused marks, and the review controls", () => {
		const html = body(
			payload({
				course: {
					id: "course_a",
					title: "Calc",
					createdAt: "t",
					updatedAt: "t",
					status: "draft",
					skills: [],
					draft: {
						createdAt: "t",
						summary: "Two skills.",
						skills: [
							{ key: "s1", reuse: "sk_old", name: "x", statement: "x", requires: [], restsOn: ["n1"], cite: "Book, p. 2" },
							{ key: "s2", name: "New", statement: "Do new", requires: ["s1"], restsOn: [] },
						],
					},
				},
				skills: [],
				nextUp: [],
				known: [],
				reused: { sk_old: { name: "Old skill", statement: "Do old" } },
			}),
		);
		assert.match(html, /Draft skill map · 2 skills · 1 reused/);
		assert.match(html, /Old skill/);
		assert.match(html, /Requires Old skill/);
		assert.match(html, /rests on 1 proposition you have learned/);
		assert.match(html, /data-testid="draft-approve"/);
		assert.doesNotMatch(html, /data-testid="course-map"/);
	});

	it("drafting shows the planner's progress and disables re-drafting", () => {
		const html = body(payload({ drafting: true }));
		assert.match(html, /data-testid="course-drafting"/);
		const button = html.match(/<button[^>]*data-testid="course-draft-button"[^>]*>/)![0];
		assert.match(button, /disabled=""/);
	});

	it("skill state words", () => {
		assert.equal(skillStateLabel({ box: 4, known: true, missing: [] }), "Known · box 4/5");
		assert.equal(skillStateLabel({ box: 0, known: false, missing: ["x"] }), "Locked");
		assert.equal(skillStateLabel({ box: 0, known: false, missing: [] }), "Not started");
		assert.equal(skillStateLabel({ box: 2, known: false, missing: [] }), "Learning · box 2/5");
	});

	it("the transcript card leads with the course and counts its skills", () => {
		const html = renderToStaticMarkup(
			<GraphContextCard
				data={{
					propositions: [{ id: "n1", name: "P", statement: "p" }],
					chains: [],
					course: { title: "Calc", mode: "review", skills: [{ id: "a", name: "A", statement: "Do a" }] },
				}}
			/>,
		);
		assert.match(html, /Calc · Review/);
		assert.match(html, /1 skill · 1 proposition/);
	});
});
