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
const mastery = await import("../src/core/mastery.ts");
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

	it("keeps the past-exam count the pass reports, and leaves it out when the pass does not say", async () => {
		const entries = [{ skill: "sk_a", weight: 3, reason: "r" }, { skill: "sk_b", weight: 0, reason: "r" }];
		const withCount = await weighCourse({ title: "T", materialsSection: "", skills, language: "en" }, deps([submit({ summary: "s", pastExams: 2, weights: entries }, "c1")]));
		assert.equal(withCount.pastExams, 2);
		const without = await weighCourse({ title: "T", materialsSection: "", skills, language: "en" }, deps([submit({ summary: "s", weights: entries }, "c1")]));
		assert.equal("pastExams" in without, false);
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
			pastExams: 1,
			updatedAt: "2026-01-02T00:00:00Z",
		});
		const renamed = course({ title: "Renamed", updatedAt: "2026-01-03T00:00:00Z" });
		for (const [l, r] of [[weighed, renamed], [renamed, weighed]]) {
			const out = merged(l, r, base);
			assert.deepEqual(out.skillWeights, { a: { w: 3, by: "model", reason: "Exam 2025" } });
			assert.equal(out.weightsSummary, "Used one exam.");
			assert.equal(out.weightsAt, "2026-01-02T00:00:00Z");
			assert.equal(out.pastExams, 1, "the past-exam count moves with the weights");
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

describe("what the teacher is told about the exam", () => {
	const NOON = new Date(2026, 10, 14, 12, 0, 0).getTime();

	it("names the date and the days left, or tomorrow or today", () => {
		assert.equal(plan.examWhen("2026-12-14", NOON), "14 Dec 2026, 30 days left");
		assert.equal(plan.examWhen("2026-11-15", NOON), "15 Nov 2026, tomorrow");
		assert.equal(plan.examWhen("2026-11-14", NOON), "14 Nov 2026, today");
	});

	it("says nothing without an exam date or once the exam has passed", () => {
		assert.equal(plan.examWhen(undefined, NOON), undefined);
		assert.equal(plan.examWhen("2026-11-13", NOON), undefined);
	});

	it("formats a date the same way the page does", () => {
		assert.equal(plan.examDateLabel("2026-12-12"), "12 Dec 2026");
	});
});

describe("exam readiness", () => {
	const skill = (priority: number, credit: number) => ({ priority, credit });

	it("a stored past-exam count is an integer from 0 to 50, anything else is unknown", () => {
		assert.equal(plan.sanitizePastExams(3), 3);
		assert.equal(plan.sanitizePastExams(0), 0);
		assert.equal(plan.sanitizePastExams(50), 50);
		for (const bad of [51, -1, 2.5, "3", null, undefined, NaN]) assert.equal(plan.sanitizePastExams(bad), undefined, String(bad));
	});

	it("a skill's weight is (frequency x exams + 1) / (exams + 2), higher for a higher priority", () => {
		assert.equal(plan.readinessWeight(3, 3), 0.8);
		assert.equal(plan.readinessWeight(2, 3), 0.5);
		assert.ok(Math.abs(plan.readinessWeight(1, 3) - 0.32) < 1e-9);
		assert.equal(plan.readinessWeight(0, 3), 0.2);
		for (const exams of [1, 2, 3, 5, 10, 50]) {
			const w = [0, 1, 2, 3].map((p) => plan.readinessWeight(p, exams));
			assert.ok(w[0]! < w[1]! && w[1]! < w[2]! && w[2]! < w[3]!, `with ${exams} exams a higher priority always weighs more: ${w.join(" < ")}`);
		}
	});

	it("the readiness bar color is orange at 0%, stays short of green below the key-skills tick, and is green from the tick up", () => {
		assert.equal(plan.readinessStep(0, 0.6), 1);
		assert.ok(plan.readinessStep(0.05, 0.6) < 2, "5% is still orange-red");
		assert.ok(plan.readinessStep(0.5999, 0.6) < 8, "just below the tick is not green yet");
		assert.equal(plan.readinessStep(0.6, 0.6), 8);
		assert.equal(plan.readinessStep(1, 0.6), 10);
		let last = 0;
		for (let s = 0; s <= 1; s += 0.01) {
			const step = plan.readinessStep(s, 0.6);
			assert.ok(step >= last, "the color never goes backwards as the score rises");
			last = step;
		}
		assert.equal(plan.readinessStep(1, 0), 10, "no key skills: the whole bar ramps, green at 100%");
		assert.ok(plan.readinessStep(0.5, 0) < 10);
		assert.equal(plan.readinessStep(1, 1), 10);
	});

	it("with no past exams every skill weighs the same, so readiness is the plain average credit", () => {
		for (const p of [0, 1, 2, 3]) assert.equal(plan.readinessWeight(p, 0), 0.5);
		const r = plan.examReadiness([skill(3, 1), skill(0, 0), skill(1, 0.5), skill(2, 0)], 0)!;
		assert.ok(Math.abs(r.score - 0.375) < 1e-9);
		assert.equal(r.assumed, false);
		assert.equal(r.pastExams, 0);
	});

	it("scores 0 with nothing learned and 1 only when every skill is fully known, even the never-tested ones", () => {
		const all = (credit: number) => [3, 3, 2, 2, 2, 1, 1, 0].map((p) => skill(p, credit));
		assert.equal(plan.examReadiness(all(0), 3)!.score, 0);
		assert.equal(plan.examReadiness(all(1), 3)!.score, 1);
		const noTail = [3, 3, 2, 2, 2, 1, 1, 0].map((p) => skill(p, p >= 1 ? 1 : 0));
		assert.ok(plan.examReadiness(noTail, 3)!.score < 1, "leaving the priority 0 skill out of reach keeps it under 100%");
	});

	it("the key point is the score with every priority 2-3 skill known and nothing else", () => {
		const skills = [skill(3, 0), skill(2, 0), skill(2, 0), skill(1, 0), skill(0, 0)];
		const r = plan.examReadiness(skills, 3)!;
		const knownCore = plan.examReadiness(skills.map((s) => skill(s.priority, s.priority >= 2 ? 1 : 0)), 3)!;
		assert.ok(Math.abs(r.key - knownCore.score) < 1e-9);
		assert.ok(r.key > 0.5 && r.key < 1);
	});

	it("fewer past exams leave the rarely tested skills more of the score", () => {
		const skills = [3, 3, 2, 2, 2, 1, 1, 1, 0, 0].map((p) => skill(p, 0));
		const tail = (exams: number) => 1 - plan.examReadiness(skills, exams)!.key;
		assert.ok(tail(2) > tail(3) && tail(3) > tail(5) && tail(5) > tail(20), "the tail share falls as the evidence grows");
	});

	it("a prerequisite that no exam asks for directly weighs like the skills built on it", () => {
		// product rule (weight 0, never a question itself) -> chain rule (weight 3): the product rule's PRIORITY is 3
		const requires: Record<string, string[]> = { chain: ["product"], product: [] };
		const weights = { chain: { w: 3 as const, by: "model" as const }, product: { w: 0 as const, by: "model" as const } };
		const priority = plan.priorities(["product", "chain"], (id) => requires[id] ?? [], weights);
		assert.equal(priority.get("product"), 3);
		assert.equal(plan.readinessWeight(priority.get("product")!, 3), plan.readinessWeight(priority.get("chain")!, 3));
		const missingFoundation = plan.examReadiness([skill(priority.get("product")!, 0), skill(priority.get("chain")!, 1)], 3)!;
		assert.ok(Math.abs(missingFoundation.score - 0.5) < 1e-9, "not knowing the foundation costs as much as not knowing the tested skill");
	});

	it("a course whose weighing recorded no count assumes three and says so", () => {
		const r = plan.examReadiness([skill(3, 1), skill(1, 0)])!;
		assert.equal(r.assumed, true);
		assert.equal(r.pastExams, plan.DEFAULT_PAST_EXAMS);
		assert.equal(plan.examReadiness([skill(3, 1)], 99)!.assumed, true, "an out-of-range count is not trusted");
		assert.equal(plan.examReadiness([], 3), null);
	});

	it("credit is clamped to 0-1, and the line under the score names its basis", () => {
		assert.equal(plan.examReadiness([skill(2, 5)], 3)!.score, 1);
		assert.equal(plan.examReadiness([skill(2, -5)], 3)!.score, 0);
		assert.equal(plan.readinessBasis({ pastExams: 3, assumed: true }), "assuming 3 past exams");
		assert.equal(plan.readinessBasis({ pastExams: 2, assumed: false }), "based on 2 past exams");
		assert.equal(plan.readinessBasis({ pastExams: 1, assumed: false }), "based on 1 past exam");
		assert.match(plan.readinessBasis({ pastExams: 0, assumed: false }), /^no past exams found/);
	});
});

// ─── the page pieces ────────────────────────────────────────────────────────

const { renderToStaticMarkup } = await import("react-dom/server");
const examUi = await import("../components/exam-plan.tsx");
const todayUi = await import("../components/today-section.tsx");
const todayPage = await import("../components/today-page.tsx");

describe("the exam plan on the page", () => {
	const names = new Map([["sk_a", "Taylor series"], ["sk_b", "Row reduction"]]);
	const basePlan = { skillsLeft: 27, reviewDue: 4, reviewBatch: 4, lessons: ["sk_a", "sk_b"] };
	const props = (over: Record<string, unknown> = {}) => ({
		courseId: "course_1", plan: basePlan, names, weightOf: (id: string) => (id === "sk_a" ? 3 : 1), readiness: null, nextUp: [] as string[], learningCount: 0, hasWeights: false, weighing: false, canWeigh: true, busy: false, onStart: () => {}, onChanged: () => {}, ...over,
	});

	it("labels days, dates and skills left", () => {
		assert.equal(examUi.examCountdown(29), "29 d");
		assert.equal(examUi.examCountdown(1), "1 d");
		assert.equal(examUi.examCountdown(0), "today");
		assert.equal(examUi.examCountdown(-3), "passed");
		assert.equal(examUi.skillsLeftLabel(27), "27 skills left");
		assert.equal(examUi.skillsLeftLabel(1), "1 skill left");
	});

	it("shows the countdown, the forecast and today's review and lessons side by side", () => {
		const html = renderToStaticMarkup(
			<examUi.ExamPlanSection {...props({ examDate: "2026-12-12", plan: { ...basePlan, examDate: "2026-12-12", daysLeft: 29, forecast: plan.forecast({ skillsLeft: 27, daysLeft: 29, pacePerDay: 1.2 }) } })} />,
		);
		assert.match(html, /data-testid="course-exam-countdown"[^>]*>[\s\S]*?29 d[\s\S]*?12 Dec 2026/);
		assert.match(html, /27 skills left/);
		assert.match(html, /needs 1 lesson\/day · your pace 1\.2\/day · on track/);
		assert.match(html, /Review · 4</);
		assert.match(html, /Learn today[\s\S]*Taylor series/);
		assert.match(html, /w3/);
		assert.ok(html.indexOf("course-next-up") < html.indexOf("course-exam-countdown"), "Next up first, the exam beside it");
		assert.match(html, />Weigh by exams</, "unweighed: the card holds the button");
		assert.ok(!html.includes('data-testid="course-exam-date"'), "with a date set the field is a setting, not on the card");
		assert.ok(!html.includes("reads your past exams"), "no long explainer");
	});

	it("shows how many skills fade before the exam and a retest row only when something is to check (owner, 2026-11-16)", () => {
		const html = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ plan: { ...basePlan, reviewFading: 3, retestCount: 5 }, onRetest: () => {} })} />);
		assert.match(html, /data-testid="course-review-fading"[^>]*>· 3 fading before the exam/);
		assert.match(html, /data-testid="course-next-retest"[\s\S]*Retest what I know · 5 to check[\s\S]*>Retest</);
		const quiet = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ plan: { ...basePlan, retestCount: 0 }, onRetest: () => {} })} />);
		assert.ok(!quiet.includes("course-next-retest") && !quiet.includes("course-review-fading"));
		const noHandler = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ plan: { ...basePlan, retestCount: 5 } })} />);
		assert.ok(!noHandler.includes("course-next-retest"));
	});

	it("with no exam date the card holds the date field", () => {
		const html = renderToStaticMarkup(<examUi.ExamPlanSection {...props()} />);
		assert.match(html, /<input[^>]*type="date"[^>]*data-testid="course-exam-date"/);
		assert.ok(!html.includes("course-exam-countdown"));
	});

	const readiness = { score: 0.5, key: 0.75, pastExams: 3, assumed: false };

	it("a weighed course shows its readiness: the percent, a bar with a tick for the key skills, and what it rests on", () => {
		const html = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ examDate: "2026-12-12", plan: { ...basePlan, daysLeft: 29 }, hasWeights: true, readiness })} />);
		assert.match(html, /data-testid="course-exam-readiness"[\s\S]*Readiness[\s\S]*50%/);
		assert.match(html, /role="meter"[^>]*aria-label="Exam readiness"[^>]*aria-valuenow="50"/);
		assert.match(html, /data-testid="course-exam-readiness-key"/);
		assert.match(html, /left:75%/, "the tick sits where the key skills end");
		assert.match(html, /based on 3 past exams/);
		assert.match(html, /key skills 75%/);
		assert.ok(!html.includes("skills known"), "the known-skills line is gone from the card");
		assert.ok(!html.includes("course-exam-readiness-prompt"));
	});

	it("a weighing that recorded no count says it assumes three", () => {
		const html = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ hasWeights: true, readiness: { ...readiness, assumed: true } })} />);
		assert.match(html, /assuming 3 past exams/);
	});

	it("a weighed course shows its readiness even without an exam date, under the date field", () => {
		const html = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ hasWeights: true, readiness })} />);
		assert.match(html, /data-testid="course-exam-date"[\s\S]*course-exam-readiness"/);
		assert.ok(!html.includes("course-exam-countdown"));
	});

	it("an unweighed course gets no score, a prompt to weigh and the button", () => {
		const html = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ examDate: "2026-12-12", plan: { ...basePlan, daysLeft: 29 } })} />);
		assert.ok(!html.includes("course-exam-readiness\""), "no score");
		assert.ok(!html.includes('role="meter"'));
		assert.match(html, /data-testid="course-exam-readiness-prompt"[^>]*>\s*Weigh by exams to get a readiness score\./);
		assert.match(html, />Weigh by exams</);
		assert.ok(!renderToStaticMarkup(<examUi.ExamPlanSection {...props({ weighing: true })} />).includes("course-exam-readiness-prompt"), "no prompt while it runs");
	});

	it("once weighed the card says so in one line and keeps no button; a failure and the spinner still show", () => {
		const weighed = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ hasWeights: true })} />);
		assert.match(weighed, /Skills weighed by exam importance\./);
		assert.ok(!weighed.includes("course-weigh-button"), "Weigh again is a setting");
		const failed = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ weightsError: "out of credit (Google)" })} />);
		assert.match(failed, /Weighing failed: out of credit \(Google\)/);
		const running = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ weighing: true })} />);
		assert.match(running, /Reading the exams…/);
		assert.match(running, /<button[^>]*disabled=""[^>]*data-testid="course-weigh-button"/);
		const noSources = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ canWeigh: false })} />);
		assert.match(noSources, /<button[^>]*disabled=""[^>]*data-testid="course-weigh-button"/);
	});

	it("the exam settings hold the date with Clear once one is set, and Weigh again with what the last weighing found", () => {
		const settings = (over: Record<string, unknown> = {}) => ({ courseId: "course_1", hasWeights: false, weighing: false, canWeigh: true, busy: false, onChanged: () => {}, ...over });
		assert.equal(renderToStaticMarkup(<examUi.ExamSettings {...settings()} />), "", "no date and not weighed: nothing to set here");
		const dated = renderToStaticMarkup(<examUi.ExamSettings {...settings({ examDate: "2026-12-12" })} />);
		assert.match(dated, /value="2026-12-12"/);
		assert.match(dated, /data-testid="course-exam-date-clear"/);
		assert.ok(!dated.includes("course-weigh-button"), "Weigh by exams is on the card until weighed");
		const weighed = renderToStaticMarkup(<examUi.ExamSettings {...settings({ hasWeights: true, weightsSummary: "Used 3 past exams.", weightsAt: "2026-11-13T10:00:00Z" })} />);
		assert.match(weighed, />Weigh again</);
		assert.match(weighed, /Last weighing \(2026-11-13\): Used 3 past exams\./);
		assert.match(weighed, /<p class="truncate[^"]*" title="Used 3 past exams\."/, "one line, the whole text on a long press");
		assert.ok(!weighed.includes("course-exam-date-clear"));
	});

	it("a lone review batch smaller than what is due says so; nothing to do hides Today", () => {
		assert.match(renderToStaticMarkup(<examUi.ExamPlanSection {...props({ plan: { ...basePlan, reviewDue: 9, reviewBatch: 6, lessons: [] } })} />), /Review · 6 of 9</);
		assert.ok(!renderToStaticMarkup(<examUi.ExamPlanSection {...props({ plan: { ...basePlan, reviewDue: 0, lessons: [] } })} />).includes("course-today"));
	});

	it("the Next up box lists the review, today's lessons, then the next four skills not already listed, each with Learn", () => {
		const ids = ["sk_a", "sk_b", "sk_c", "sk_d", "sk_e", "sk_f", "sk_g"];
		const many = new Map(ids.map((id) => [id, `Skill ${id.slice(3)}`]));
		const html = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ names: many, nextUp: ids })} />);
		assert.match(html, /data-testid="course-next-up"[\s\S]*>Next up</);
		assert.match(html, /Review · 4</);
		assert.match(html, /Learn today[\s\S]*Skill a[\s\S]*Skill b/);
		assert.match(html, /More to learn[\s\S]*Skill c[\s\S]*Skill d[\s\S]*Skill e[\s\S]*Skill f/);
		assert.ok(!html.includes("Skill g"), "four more, no more");
		assert.equal(html.match(/data-testid="course-next-more-/g)?.length, 4);
		assert.equal(html.match(/>Learn</g)?.length, 6, "a Learn button on each of the two lessons and the four more");
		assert.ok(html.indexOf("Learn today") < html.indexOf("More to learn"), "today's lessons come first");
	});

	it("the Next up box offers one row to practice several learning skills together, and is left out when there is nothing", () => {
		const none = { ...basePlan, reviewDue: 0, lessons: [] as string[] };
		const withPractice = renderToStaticMarkup(<examUi.ExamPlanSection {...props({ plan: none, learningCount: 8 })} />);
		assert.match(withPractice, /data-testid="course-next-practice"[\s\S]*Practice · 8 learning[\s\S]*>Practice</);
		assert.ok(!renderToStaticMarkup(<examUi.ExamPlanSection {...props({ plan: none, learningCount: 1 })} />).includes("course-next-practice"), "a single learning skill has its own button");
		assert.ok(!renderToStaticMarkup(<examUi.ExamPlanSection {...props({ plan: none })} />).includes("course-next-up"), "nothing to do: no box");
	});

	it("a skill row's weight chip appears when set or not the default; the editor says where the weight came from", () => {
		assert.equal(examUi.weightChip({ weight: 1 }), null);
		assert.equal(examUi.weightChip({ weight: 3 }), "w3");
		assert.equal(examUi.weightChip({ weight: 1, weightBy: "learner" }), "w1");
		const note = renderToStaticMarkup(<examUi.WeightNote skill={{ id: "sk_a", weight: 0, weightBy: "model", weightReason: "Exam 2025 task 3", priority: 2 }} />);
		assert.match(note, /Exam weight 0 · not examined · from the sources · counts as 2 because later skills build on it · Exam 2025 task 3/);
		assert.match(renderToStaticMarkup(<examUi.WeightNote skill={{ id: "sk_a", weight: 3, weightBy: "learner", priority: 3 }} />), /set by you/);
		// the compact control: a label, the four buttons, a few words on what the weight means, Reset only after a hand edit
		const plain = renderToStaticMarkup(<examUi.WeightEditor skill={{ id: "sk_a", weight: 0, weightBy: "model", priority: 2 }} />);
		assert.match(plain, /Exam weight[\s\S]*not examined · counts as 2/);
		assert.ok(!plain.includes("because later skills build on it"), "the long sentence is under More");
		assert.ok(!plain.includes("Exam 2025"), "so is the evidence");
		const edit = renderToStaticMarkup(
			<examUi.WeightEditContext.Provider value={() => {}}>
				<examUi.WeightEditor skill={{ id: "sk_a", weight: 3, weightBy: "learner", priority: 3 }} />
			</examUi.WeightEditContext.Provider>,
		);
		assert.match(edit, /nearly every exam/);
		for (const w of [0, 1, 2, 3]) assert.match(edit, new RegExp(`data-testid="weight-sk_a-${w}"`));
		assert.match(edit, /aria-pressed="true"[^>]*data-testid="weight-sk_a-3"/, "the current weight is pressed");
		assert.match(edit, /data-testid="weight-sk_a-reset"/);
		const byModel = renderToStaticMarkup(
			<examUi.WeightEditContext.Provider value={() => {}}>
				<examUi.WeightEditor skill={{ id: "sk_a", weight: 2, weightBy: "model", priority: 2 }} />
			</examUi.WeightEditContext.Provider>,
		);
		assert.ok(!byModel.includes("weight-sk_a-reset"), "nothing to reset: the model set it");
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

	it("the header counts the item lines, not the course headings", () => {
		const lines = todayUi.todayLines([course("A", { daysLeft: 3, reviewDue: 2, lessons: [lesson("x")] }), course("B", { lessons: [lesson("y")] })]);
		assert.equal(lines.length, 5);
		assert.equal(todayUi.todayCount(lines), 3);
		assert.equal(todayUi.todayCount([]), 0);
	});

	it("renders nothing until something is due (the section hides itself)", () => {
		assert.deepEqual(todayUi.todayLines([]), []);
		assert.deepEqual(todayUi.todayLines([course("Empty")]), []);
	});

	it("the sidebar row counts every item uncapped, as the Today page lists them (owner, 2026-11-16)", () => {
		const many = [course("One", { reviewDue: 2, lessons: [lesson("a"), lesson("b"), lesson("c")] }), course("Two", { lessons: [lesson("d"), lesson("e"), lesson("f")] })];
		assert.equal(todayUi.todayItemCount(many), 7, "not capped at five");
		assert.equal(todayUi.todayItemCount([]), 0);
	});

	it("the Today page says the days to each course's exam", () => {
		assert.equal(todayPage.examDaysLine(15), "15 days to the exam");
		assert.equal(todayPage.examDaysLine(1), "1 day to the exam");
		assert.equal(todayPage.examDaysLine(0), "exam today");
		assert.equal(todayPage.examDaysLine(-3), "exam passed");
		assert.equal(todayPage.examDaysLine(undefined), null);
	});
});

describe("exam-aware review (owner, 2026-11-16)", () => {
	const NOW = Date.parse("2026-11-16T12:00:00");
	const state = (stability: number, daysAgo: number) => ({ stability, difficulty: 5, lastReview: NOW - daysAgo * DAY });

	it("examInstant is the exam day, now on the day itself, and nothing without a date or after it", () => {
		assert.equal(plan.examInstant(undefined, NOW), undefined);
		assert.equal(plan.examInstant("2026-11-15", NOW), undefined, "passed");
		assert.equal(plan.examInstant("2026-11-16", NOW), NOW, "today");
		assert.equal(plan.examInstant("2026-11-28", NOW), NOW + 12 * DAY);
	});

	it("fadesBefore projects the 90% line forward", () => {
		const s = state(20, 1);
		assert.equal(mastery.needsReview(s as never, NOW), false, "fine today");
		assert.equal(mastery.fadesBefore(s, NOW + 12 * DAY), false, "20-day stability still above 90% 13 days after the review");
		assert.equal(mastery.fadesBefore(state(8, 1), NOW + 12 * DAY), true, "an 8-day stability is below 90% by then");
	});

	it("partitionSkills puts a skill that fades before the exam in review and in fading; today's due skills stay due only", () => {
		const skills = new Map([["fine", { id: "fine" }], ["soon", { id: "soon" }], ["due", { id: "due" }]].map(([id, v]) => [id as string, { ...(v as object), name: id, statement: "x", requires: [], restsOn: [] }])) as never;
		const states = new Map([
			["fine", state(60, 1)],
			["soon", state(8, 1)],
			["due", state(2, 5)],
		]);
		const without = mastery.partitionSkills(["fine", "soon", "due"], skills, states, NOW);
		assert.deepEqual(without.review, ["due"]);
		assert.deepEqual(without.fading, []);
		const withExam = mastery.partitionSkills(["fine", "soon", "due"], skills, states, NOW, undefined, NOW + 12 * DAY);
		assert.deepEqual([...withExam.review].sort(), ["due", "soon"]);
		assert.deepEqual(withExam.fading, ["soon"], "due is not fading: it is due now");
		assert.equal(withExam.states.get("soon")!.needsReview, false, "the skill view still says recall is fine today");
		assert.equal(withExam.states.get("soon")!.fading, true);
	});

	it("examReviewScore: exam weight times the loss by exam day; a priority 0 skill sinks but does not vanish", () => {
		const high = plan.examReviewScore(3, 4, 0.5);
		const low = plan.examReviewScore(1, 4, 0.5);
		const none = plan.examReviewScore(0, 4, 0.5);
		assert.ok(high > low && low > none && none > 0);
		assert.equal(plan.examReviewScore(3, 4, 1), 0, "nothing lost, nothing to review");
		assert.ok(plan.examReviewScore(2, 4, 0.2) > plan.examReviewScore(2, 4, 0.8));
	});

	it("pickReviewSkills with a score takes the highest scores as the weakest, keeping the stalest and the morale skill", () => {
		const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
		const states = new Map(ids.map((id, i) => [id, { state: state(1 + i, 2 + (id === "h" ? 80 : 0)), learned: true, known: false, needsReview: true, fading: false, missing: [] }]));
		const p = { review: ids, states } as never;
		// without a score: a..d are the four weakest (lowest understanding), h the stalest, g the strongest left = morale
		assert.deepEqual([...mastery.pickReviewSkills(p)].sort(), ["a", "b", "c", "d", "g", "h"]);
		// the exam makes e, f, g, d the costliest; h stays the stalest; the strongest left is morale
		const score = (id: string) => ({ e: 9, f: 8, g: 7, d: 6 })[id] ?? 0;
		const picked = mastery.pickReviewSkills(p, undefined, score);
		assert.equal(picked.length, 6);
		for (const id of ["e", "f", "g", "d", "h"]) assert.ok(picked.includes(id), `${id} picked`);
		assert.equal(picked[0], picked.reduce((best, id) => (states.get(id)!.state.stability > states.get(best)!.state.stability ? id : best)), "morale (the strongest) first");
	});

});
