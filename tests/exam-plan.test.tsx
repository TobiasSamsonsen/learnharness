/**
 * EXAM PRIORITIES (owner, 2026-11-13 — core/exam-plan.ts): the pure planning rules, the weigher against a scripted
 * model, the course view's ordering and plan, the hand edits and routes, Today, and the sync merge of the new
 * course fields. LH_DATA_DIR is set before the first import that loads config.ts.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exam-plan-"));
process.env.LH_DATA_DIR = TMP_DATA;

const plan = await import("../src/core/exam-plan.ts");
const { weighCourse, weightsProblems } = await import("../src/agent/subagents/exam-weigher.ts");
const { courseStore } = await import("../src/store/courses.ts");
const courses = await import("../src/server/courses.ts");
const { PATCH, GET } = await import("../app/api/courses/[id]/route.ts");
const { GET: todayGET } = await import("../app/api/today/route.ts");
const { mergeFile } = await import("../src/core/sync-merge.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const DAY = 86_400_000;

describe("priorities and the order of Next up", () => {
	// a -> b -> c (c needs b, b needs a); d stands alone
	const requires: Record<string, string[]> = { a: [], b: ["a"], c: ["b"], d: [] };
	const ids = ["a", "b", "c", "d"];
	const req = (id: string) => requires[id] ?? [];

	it("a skill counts the highest weight among itself and everything it unlocks", () => {
		const p = plan.priorities(ids, req, { c: { w: 3, by: "model" }, a: { w: 0, by: "model" }, b: { w: 1, by: "model" }, d: { w: 2, by: "model" } });
		assert.deepEqual([...p], [["a", 3], ["b", 3], ["c", 3], ["d", 2]]);
	});

	it("with no weights every priority ties, so the order stays topological", () => {
		const p = plan.priorities(ids, req, undefined);
		assert.ok([...p.values()].every((v) => v === 1));
		assert.deepEqual(plan.orderNextUp(["a", "d"], p), { nextUp: ["a", "d"], notExamined: [] });
	});

	it("orders by priority, topological within a priority, and splits off what no exam uses", () => {
		const p = plan.priorities(ids, req, { a: { w: 1, by: "model" }, b: { w: 1, by: "model" }, c: { w: 1, by: "model" }, d: { w: 3, by: "learner" } });
		assert.deepEqual(plan.orderNextUp(["a", "d"], p).nextUp, ["d", "a"]);
		const none = plan.priorities(ids, req, { a: { w: 0, by: "model" }, b: { w: 0, by: "model" }, c: { w: 0, by: "model" }, d: { w: 2, by: "model" } });
		assert.deepEqual(plan.orderNextUp(["a", "d"], none), { nextUp: ["d"], notExamined: ["a"] });
	});

	it("an unexamined prerequisite of an examined skill stays in Next up", () => {
		const p = plan.priorities(ids, req, { a: { w: 0, by: "model" }, b: { w: 0, by: "model" }, c: { w: 2, by: "model" }, d: { w: 0, by: "model" } });
		assert.deepEqual(plan.orderNextUp(["a", "d"], p), { nextUp: ["a"], notExamined: ["d"] });
	});

	it("weights are sanitized, and a re-weigh keeps the learner's hand edits", () => {
		assert.equal(plan.sanitizeWeights("nope"), undefined);
		assert.deepEqual(plan.sanitizeWeights({ a: { w: 3, reason: " r ", by: "learner" }, b: { w: 9 }, c: 4, d: { w: 0 } }), {
			a: { w: 3, reason: "r", by: "learner" },
			d: { w: 0, by: "model" },
		});
		const merged = plan.mergeModelWeights(
			{ a: { w: 3, by: "learner" }, b: { w: 2, by: "model" }, gone: { w: 1, by: "learner" } },
			[{ skill: "a", weight: 0, reason: "x" }, { skill: "b", weight: 1, reason: "Exam 2025 task 3" }, { skill: "z", weight: 2, reason: "unknown" }],
			["a", "b", "c"],
		);
		assert.deepEqual(merged, { a: { w: 3, by: "learner" }, b: { w: 1, reason: "Exam 2025 task 3", by: "model" } });
	});
});

describe("the exam date, pace and forecast", () => {
	it("accepts real calendar dates only", () => {
		assert.equal(plan.parseExamDate("2026-12-12"), "2026-12-12");
		assert.equal(plan.parseExamDate(" 2026-02-28 "), "2026-02-28");
		for (const bad of ["2026-02-30", "2026-13-01", "12.12.2026", "", 5, null]) assert.equal(plan.parseExamDate(bad), null, String(bad));
	});

	it("counts whole days from today, negative after the exam", () => {
		const now = new Date(2026, 10, 13, 15, 30).getTime();
		assert.equal(plan.daysUntil("2026-11-13", now), 0);
		assert.equal(plan.daysUntil("2026-12-12", now), 29);
		assert.equal(plan.daysUntil("2026-11-10", now), -3);
	});

	it("the pace is finishes over the window, a young course judged over the days it has existed (at least 3)", () => {
		const now = Date.parse("2026-11-13T12:00:00Z");
		const finishes = [now - DAY, now - 2 * DAY, now - 20 * DAY];
		assert.equal(plan.lessonsPerDay(finishes, now), 2 / 14, "the old finish is outside the window");
		assert.equal(plan.lessonsPerDay(finishes, now, now - 4 * DAY), 2 / 4);
		assert.equal(plan.lessonsPerDay([now - DAY], now, now - DAY), 1 / 3, "never fewer than 3 days");
		assert.equal(plan.lessonsPerDay([], now), 0);
	});

	it("says whether the pace gets there", () => {
		assert.deepEqual(plan.forecast({ skillsLeft: 27, daysLeft: 29, pacePerDay: 1.2 }), { status: "on-track", neededPerDay: 1, pacePerDay: 1.2 });
		assert.equal(plan.forecast({ skillsLeft: 4, daysLeft: 26692, pacePerDay: 0 }).neededPerDay, 0.1, "a far exam never needs 0 lessons a day");
		assert.deepEqual(plan.forecast({ skillsLeft: 27, daysLeft: 9, pacePerDay: 1.2 }), { status: "behind", neededPerDay: 3, pacePerDay: 1.2 });
		assert.equal(plan.forecast({ skillsLeft: 5, daysLeft: 10, pacePerDay: 0 }).status, "no-pace");
		assert.equal(plan.forecast({ skillsLeft: 0, daysLeft: 10, pacePerDay: 0 }).status, "done");
		assert.equal(plan.forecast({ skillsLeft: 3, daysLeft: 0, pacePerDay: 1 }).status, "exam-today");
		assert.equal(plan.forecast({ skillsLeft: 3, daysLeft: -1, pacePerDay: 1 }).status, "past");
		assert.equal(plan.forecastLine(plan.forecast({ skillsLeft: 27, daysLeft: 29, pacePerDay: 1.2 })), "needs 1 lesson/day · your pace 1.2/day · on track");
		assert.equal(plan.forecastLine(plan.forecast({ skillsLeft: 5, daysLeft: 10, pacePerDay: 0 })), "needs 0.5 lessons/day · no lessons finished lately");
	});

	it("suggests 1 to 3 lessons today: enough for the pace, one without an exam date, none with nothing next", () => {
		assert.equal(plan.lessonsToday(null, 8), 1);
		assert.equal(plan.lessonsToday(0.3, 8), 1);
		assert.equal(plan.lessonsToday(1.1, 8), 2);
		assert.equal(plan.lessonsToday(7, 8), 3);
		assert.equal(plan.lessonsToday(2, 1), 1);
		assert.equal(plan.lessonsToday(2, 0), 0);
	});
});

describe("the exam weigher (scripted model)", () => {
	const skills = [{ id: "sk_a", name: "A", statement: "Do a" }, { id: "sk_b", name: "B", statement: "Do b" }];
	function engine(steps: FauxResponseStep[]) {
		const faux = createFauxCore({});
		faux.setResponses(steps);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	}
	const submit = (input: unknown, id: string) => () => fauxAssistantMessage([fauxToolCall("submit_weights", input as ToolCall["arguments"], { id })], { stopReason: "toolUse" });
	const deps = (steps: FauxResponseStep[]) => ({ engine: engine(steps), tools: {}, courseId: "course_t", onStep: () => {} });

	it("an incomplete answer is sent back; the corrected one is returned", async () => {
		const partial = { summary: "Used Exam 2025.", weights: [{ skill: "sk_a", weight: 3, reason: "Exam 2025 task 1" }] };
		const full = { summary: "Used Exam 2025.", weights: [{ skill: "sk_a", weight: 3, reason: "Exam 2025 task 1" }, { skill: "sk_b", weight: 0, reason: "never examined" }] };
		const out = await weighCourse({ title: "T", materialsSection: "<curriculum/>", skills, language: "en" }, deps([submit(partial, "c1"), submit(full, "c2")]));
		assert.deepEqual(out.weights.map((w) => [w.skill, w.weight]), [["sk_a", 3], ["sk_b", 0]]);
		assert.equal(out.summary, "Used Exam 2025.");
	});

	it("reads a weights array the model sent as one JSON string", async () => {
		const stringified = { summary: "s", weights: JSON.stringify([{ skill: "sk_a", weight: 1, reason: "r" }, { skill: "sk_b", weight: 2, reason: "r" }]) };
		const out = await weighCourse({ title: "T", materialsSection: "", skills, language: "en" }, deps([submit(stringified, "c1")]));
		assert.equal(out.weights.length, 2);
	});

	it("the check names a missing, repeated and unknown skill", () => {
		const entry = (skill: string) => ({ skill, weight: 1 as const, reason: "r" });
		assert.deepEqual(weightsProblems({ summary: "s", weights: [entry("sk_a"), entry("sk_b")] }, ["sk_a", "sk_b"]), []);
		const problems = weightsProblems({ summary: "s", weights: [entry("sk_a"), entry("sk_a"), entry("sk_z")] }, ["sk_a", "sk_b"]);
		assert.equal(problems.length, 3);
		assert.match(problems.join("\n"), /"sk_z" is not a listed skill id/);
		assert.match(problems.join("\n"), /"sk_a" has more than one entry/);
		assert.match(problems.join("\n"), /no entry for "sk_b"/);
	});
});

// ─── the course view, the hand edits, the routes and Today ──────────────────

function approvedCourse(title: string, skillDefs: Array<{ key: string; requires?: string[] }>) {
	const course = courseStore.createCourse(title);
	courseStore.updateCourse(course.id, {
		status: "draft",
		draft: { createdAt: "t", summary: "s", skills: skillDefs.map((s) => ({ key: s.key, name: s.key.toUpperCase(), statement: `Do ${s.key}`, requires: s.requires ?? [], restsOn: [] })) },
	});
	const approved = courses.approveCourse(course.id);
	assert.ok(approved.ok);
	const byKey = new Map(skillDefs.map((d, i) => [d.key, approved.value.skills[i]!]));
	return { courseId: course.id, id: (key: string) => byKey.get(key)! };
}

const patch = (courseId: string, body: unknown) =>
	PATCH(new Request(`http://x/api/courses/${courseId}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: courseId }) });

describe("the course view with weights", () => {
	it("orders Next up by priority, splits off unexamined skills, and counts what is left", () => {
		const { courseId, id } = approvedCourse("Calc", [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d", requires: ["c"] }]);
		const before = courses.courseView(courseId)!;
		assert.deepEqual(before.nextUp, [id("a"), id("b"), id("c")], "no weights: topological order as before");
		assert.deepEqual(before.notExamined, []);
		assert.ok(before.skills.every((s) => s.weight === 1 && s.priority === 1));
		assert.equal(before.plan.skillsLeft, 4);
		assert.equal(before.plan.forecast, undefined, "no exam date, no forecast");
		assert.deepEqual(before.plan.lessons, [id("a")], "one lesson today without an exam date");

		const set = courses.setCourseSkillWeights(courseId, { [id("a")]: 0, [id("b")]: 3, [id("c")]: 0, [id("d")]: 2 });
		assert.ok(set.ok);
		const view = courses.courseView(courseId)!;
		assert.deepEqual(view.nextUp, [id("b"), id("c")], "b is heaviest; c unlocks the examined d");
		assert.deepEqual(view.notExamined, [id("a")]);
		assert.equal(view.skills.find((s) => s.id === id("c"))!.priority, 2);
		assert.equal(view.skills.find((s) => s.id === id("c"))!.weight, 0);
		assert.equal(view.skills.find((s) => s.id === id("b"))!.weightBy, "learner");
		assert.equal(view.plan.skillsLeft, 3, "the unexamined skill is not counted");
	});

	it("an exam date adds the countdown and the forecast", () => {
		const { courseId } = approvedCourse("Phys", [{ key: "a" }, { key: "b" }]);
		const set = courses.setCourseExamDate(courseId, "2099-12-12");
		assert.equal(set?.examDate, "2099-12-12");
		const plan1 = courses.courseView(courseId)!.plan;
		assert.equal(plan1.examDate, "2099-12-12");
		assert.ok((plan1.daysLeft ?? 0) > 1000);
		assert.equal(plan1.forecast?.status, "no-pace");
		const past = courses.setCourseExamDate(courseId, "2000-01-01");
		assert.equal(past?.examDate, "2000-01-01");
		assert.equal(courses.courseView(courseId)!.plan.forecast?.status, "past");
	});

	it("hand edits: only the course's own skills, 0-3 or null, and null clears", () => {
		const { courseId, id } = approvedCourse("Chem", [{ key: "a" }]);
		assert.equal(courses.setCourseSkillWeights(courseId, { sk_other: 2 }).ok, false);
		assert.equal(courses.parseWeightsField({ [id("a")]: 5 }).ok, false);
		assert.equal(courses.parseWeightsField([1]).ok, false);
		assert.ok(courses.setCourseSkillWeights(courseId, { [id("a")]: 3 }).ok);
		assert.deepEqual(courseStore.getCourse(courseId)!.skillWeights, { [id("a")]: { w: 3, by: "learner" } });
		assert.ok(courses.setCourseSkillWeights(courseId, { [id("a")]: null }).ok);
		assert.equal(courseStore.getCourse(courseId)!.skillWeights, undefined);
	});

	it("weighing needs approved skills and a curriculum", () => {
		const bare = courseStore.createCourse("Bare");
		const none = courses.startCourseWeighing(bare.id);
		assert.equal(!none.ok && none.status, 400);
		const { courseId } = approvedCourse("Bio", [{ key: "a" }]);
		const noMaterial = courses.startCourseWeighing(courseId);
		assert.equal(!noMaterial.ok && noMaterial.status, 400);
		assert.match(!noMaterial.ok ? noMaterial.error : "", /curriculum/);
		assert.equal(courses.courseWeighing(courseId), false);
		assert.equal(courses.startCourseWeighing("course_nope").ok, false);
	});
});

describe("the routes", () => {
	it("PATCH sets and clears the exam date and the weights, and refuses bad ones", async () => {
		const { courseId, id } = approvedCourse("Math", [{ key: "a" }]);
		const ok = await patch(courseId, { examDate: "2099-06-01" });
		assert.equal(ok.status, 200);
		assert.equal(((await ok.json()) as { examDate?: string }).examDate, "2099-06-01");
		assert.equal((await patch(courseId, { examDate: "2099-02-30" })).status, 400);
		assert.equal((await patch(courseId, { weights: { [id("a")]: 7 } })).status, 400);
		assert.equal((await patch(courseId, { weights: { sk_other: 1 } })).status, 400);
		assert.equal((await patch(courseId, { weights: { [id("a")]: 2 } })).status, 200);
		assert.equal(courseStore.getCourse(courseId)!.skillWeights?.[id("a")]?.w, 2);
		const cleared = await patch(courseId, { examDate: null });
		assert.equal(cleared.status, 200);
		assert.equal(courseStore.getCourse(courseId)!.examDate, undefined);
		assert.equal((await patch("course_nope", { examDate: "2099-06-01" })).status, 404);
		const got = await GET(new Request("http://x"), { params: Promise.resolve({ id: courseId }) });
		const body = (await got.json()) as { weighing: boolean; plan: { skillsLeft: number }; notExamined: string[] };
		assert.equal(body.weighing, false);
		assert.equal(body.plan.skillsLeft, 1);
		assert.deepEqual(body.notExamined, []);
	});

	it("Today lists the courses with something to do, the soonest exam first", async () => {
		const soon = approvedCourse("Soon", [{ key: "a" }, { key: "b" }]);
		const later = approvedCourse("Later", [{ key: "a" }]);
		courses.setCourseExamDate(later.courseId, "2099-12-12");
		courses.setCourseExamDate(soon.courseId, "2099-01-01");
		const res = await todayGET();
		const body = (await res.json()) as { courses: Array<{ courseId: string; title: string; lessons: Array<{ skillId: string }>; reviewDue: number }> };
		const titles = body.courses.map((c) => c.title);
		assert.ok(titles.indexOf("Soon") >= 0 && titles.indexOf("Soon") < titles.indexOf("Later"), "soonest exam first");
		const entry = body.courses.find((c) => c.title === "Soon")!;
		assert.ok(entry.lessons.length >= 1 && entry.lessons.length <= 3);
		assert.equal(entry.lessons[0]!.skillId, soon.id("a"));
		assert.equal(entry.reviewDue, 0);
	});
});

describe("sync: the exam date per field, the weights as one unit", () => {
	const course = (over: Record<string, unknown>) => ({ id: "course_1", title: "T", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", status: "active", skills: ["a"], version: 1, ...over });
	const merged = (local: unknown, remote: unknown, base: unknown) => {
		const r = mergeFile({ path: "courses/course_1.json", base: JSON.stringify(base), prefer: "local", local: JSON.stringify(local), remote: JSON.stringify(remote) });
		return JSON.parse(r.content ?? "null") as Record<string, unknown>;
	};
	const base = course({});

	it("an exam date set on one device and a title change on the other both survive", () => {
		const a = course({ examDate: "2026-12-12", updatedAt: "2026-01-02T00:00:00Z" });
		const b = course({ title: "Renamed", updatedAt: "2026-01-03T00:00:00Z" });
		const out = merged(a, b, base);
		assert.equal(out.examDate, "2026-12-12");
		assert.equal(out.title, "Renamed");
	});

	it("the weights, their summary and time move together from the side that changed them", () => {
		const weighed = course({
			skillWeights: { a: { w: 3, by: "model", reason: "Exam 2025" } },
			weightsSummary: "Used one exam.",
			weightsAt: "2026-01-02T00:00:00Z",
			updatedAt: "2026-01-02T00:00:00Z",
		});
		const renamed = course({ title: "Renamed", updatedAt: "2026-01-03T00:00:00Z" });
		for (const [l, r] of [[weighed, renamed], [renamed, weighed]]) {
			const out = merged(l, r, base);
			assert.deepEqual(out.skillWeights, { a: { w: 3, by: "model", reason: "Exam 2025" } });
			assert.equal(out.weightsSummary, "Used one exam.");
			assert.equal(out.weightsAt, "2026-01-02T00:00:00Z");
			assert.equal(out.title, "Renamed");
		}
	});

	it("cleared weights stay cleared", () => {
		const had = course({ skillWeights: { a: { w: 1, by: "learner" } } });
		const cleared = course({ updatedAt: "2026-01-02T00:00:00Z" });
		const out = merged(cleared, had, had);
		assert.equal("skillWeights" in out, false);
	});
});

// ─── the page pieces ────────────────────────────────────────────────────────

const { renderToStaticMarkup } = await import("react-dom/server");
const examUi = await import("../components/exam-plan.tsx");
const todayUi = await import("../components/today-section.tsx");

describe("the exam plan on the page", () => {
	const names = new Map([["sk_a", "Taylor series"], ["sk_b", "Row reduction"]]);
	const basePlan = { skillsLeft: 27, reviewDue: 4, reviewBatch: 4, lessons: ["sk_a", "sk_b"] };
	const props = (over: Record<string, unknown> = {}) => ({
		courseId: "course_1", plan: basePlan, names, weightOf: (id: string) => (id === "sk_a" ? 3 : 1), hasWeights: false, weighing: false, canWeigh: true, busy: false, onStart: () => {}, onChanged: () => {}, ...over,
	});

	it("labels days and dates", () => {
		assert.equal(examUi.daysLeftLabel(29), "29 days left");
		assert.equal(examUi.daysLeftLabel(1), "exam tomorrow");
		assert.equal(examUi.daysLeftLabel(0), "exam today");
		assert.equal(examUi.daysLeftLabel(-3), "passed 3 days ago");
		assert.equal(examUi.examDateLabel("2026-12-12"), "12 Dec 2026");
		assert.equal(examUi.planHeadline({ examDate: "2026-12-12", daysLeft: 29, skillsLeft: 27 }), "12 Dec 2026 · 29 days left · 27 skills left");
		assert.equal(examUi.planHeadline({ skillsLeft: 1 }), "1 skill left");
	});

	it("shows the countdown, the forecast and today's review and lessons", () => {
		const html = renderToStaticMarkup(
			<examUi.ExamPlanSection {...props({ examDate: "2026-12-12", plan: { ...basePlan, examDate: "2026-12-12", daysLeft: 29, forecast: plan.forecast({ skillsLeft: 27, daysLeft: 29, pacePerDay: 1.2 }) } })} />,
		);
		assert.match(html, /value="2026-12-12"/);
		assert.match(html, /12 Dec 2026 · 29 days left · 27 skills left/);
		assert.match(html, /needs 1 lesson\/day · your pace 1\.2\/day · on track/);
		assert.match(html, /Review · 4 due/);
		assert.match(html, /Learn: Taylor series/);
		assert.match(html, /w3/);
		assert.match(html, />Weigh by exams</);
		assert.match(html, /Weigh by exams reads your past exams/);
	});

	it("says Weigh again once weighed, shows the summary and a failure, and the spinner while it runs", () => {
		const weighed = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ hasWeights: true, weightsSummary: "Used 3 past exams.", weightsAt: "2026-11-13T10:00:00Z" })} />);
		assert.match(weighed, />Weigh again</);
		assert.match(weighed, /Weighed by the sources \(2026-11-13\): Used 3 past exams\./);
		assert.ok(!weighed.includes("Weigh by exams reads your past exams"));
		const failed = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ weightsError: "out of credit (Google)" })} />);
		assert.match(failed, /Weighing failed: out of credit \(Google\)/);
		const running = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ weighing: true })} />);
		assert.match(running, /Reading the exams…/);
		assert.match(running, /<button[^>]*disabled=""[^>]*data-testid="course-weigh-button"/);
		const noSources = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ canWeigh: false })} />);
		assert.match(noSources, /<button[^>]*disabled=""[^>]*data-testid="course-weigh-button"/);
	});

	it("a lone review batch smaller than what is due says so; nothing to do hides Today", () => {
		assert.match(renderToStaticMarkup(<examUi.ExamPlanSection {...props({ plan: { ...basePlan, reviewDue: 9, reviewBatch: 6, lessons: [] } })} />), /Review · 6 of 9 due/);
		assert.ok(!renderToStaticMarkup(<examUi.ExamPlanSection {...props({ plan: { ...basePlan, reviewDue: 0, lessons: [] } })} />).includes("course-today"));
	});

	it("a skill row's weight chip appears when set or not the default; the editor says where the weight came from", () => {
		assert.equal(examUi.weightChip({ weight: 1 }), null);
		assert.equal(examUi.weightChip({ weight: 3 }), "w3");
		assert.equal(examUi.weightChip({ weight: 1, weightBy: "learner" }), "w1");
		const html = renderToStaticMarkup(<examUi.WeightEditor skill={{ id: "sk_a", weight: 0, weightBy: "model", weightReason: "Exam 2025 task 3", priority: 2 }} />);
		assert.match(html, /Exam weight 0 · not examined · from the sources · counts as 2 because later skills build on it · Exam 2025 task 3/);
		const edit = renderToStaticMarkup(
			<examUi.WeightEditContext.Provider value={() => {}}>
				<examUi.WeightEditor skill={{ id: "sk_a", weight: 3, weightBy: "learner", priority: 3 }} />
			</examUi.WeightEditContext.Provider>,
		);
		assert.match(edit, /set by you/);
		assert.match(edit, /data-testid="weight-sk_a-3"/);
		assert.match(edit, /data-testid="weight-sk_a-reset"/);
	});
});

describe("the sidebar's Today lines", () => {
	const course = (title: string, over: Record<string, unknown> = {}) => ({ courseId: `c_${title}`, title, reviewDue: 0, reviewBatch: 0, lessons: [] as Array<{ skillId: string; name: string; weight: number }>, ...over });
	const lesson = (name: string) => ({ skillId: `sk_${name}`, name, weight: 1 });

	it("heads each course with its days, then the review, then the lessons", () => {
		const lines = todayUi.todayLines([course("Matte 1", { daysLeft: 29, reviewDue: 4, reviewBatch: 4, lessons: [lesson("Taylor"), lesson("Rows")] })]);
		assert.deepEqual(lines.map((l) => l.text), ["Matte 1 · 29 days", "Review (4 due)", "Learn: Taylor", "Learn: Rows"]);
		assert.equal(todayUi.todayHead({ title: "A", daysLeft: 0 }), "A · exam today");
		assert.equal(todayUi.todayHead({ title: "A", daysLeft: 1 }), "A · 1 day");
		assert.equal(todayUi.todayHead({ title: "A", daysLeft: -2 }), "A · exam passed");
		assert.equal(todayUi.todayHead({ title: "A" }), "A");
	});

	it("stops at five item lines and leaves out a course that does not fit at all", () => {
		const lines = todayUi.todayLines([
			course("One", { reviewDue: 2, lessons: [lesson("a"), lesson("b"), lesson("c")] }),
			course("Two", { lessons: [lesson("d"), lesson("e"), lesson("f")] }),
			course("Three", { lessons: [lesson("g")] }),
		]);
		assert.equal(lines.filter((l) => l.kind !== "head").length, 5);
		assert.deepEqual(lines.filter((l) => l.kind === "head").map((l) => l.text), ["One", "Two"]);
	});

	it("renders nothing until something is due (the section hides itself)", () => {
		assert.deepEqual(todayUi.todayLines([]), []);
		assert.deepEqual(todayUi.todayLines([course("Empty")]), []);
	});
});
