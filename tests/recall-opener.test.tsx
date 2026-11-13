/**
 * THE RECALL OPENER (owner, 2026-11-13): a course lesson opens with one or two short free-form questions on learned
 * prerequisites (`explain`, type recall, with `skill`). The grader rates them when the lesson finishes and each is a
 * review of its skill. Also the mixed order of "Practice all".
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";

import { lessonGradeHook } from "../src/agent/lesson-grade.ts";
import { installPracticeGrader } from "../src/agent/practice-grade.ts";
import { createTeacherTools, explainScopeProblem, type TeacherToolContext } from "../src/agent/tools.ts";
import { coursePromptSection } from "../src/core/course-session.ts";
import { recallOpenersOf } from "../src/core/final-problem.ts";
import { hintEligible } from "../src/core/hints.ts";
import { foldSkills, skillEventsOf, understandingOf } from "../src/core/mastery.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { normalizeQuizType, questionNeedsReveal } from "../src/core/question-core.ts";
import { shuffled } from "../src/server/courses.ts";

const STAMPS = { api: "faux", provider: "test", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" };
let t = 1000;
const assistant = (content: unknown[]): LhMessage => ({ id: `m${t}`, role: "assistant", content, ...STAMPS, timestamp: t++ }) as unknown as LhMessage;
const result = (toolCallId: string, toolName: string, details: unknown = null, isError = false): LhMessage =>
	({ id: `m${t}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp: t++ }) as unknown as LhMessage;
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });

const opener = (id: string, skill: string | undefined, question = "Differentiate x^2 sin x.") =>
	assistant([call(id, "explain", { type: "recall", nodeId: "n", lead: "Quick one from earlier.", question, correctAnswer: "2x sin x + x^2 cos x", ...(skill ? { skill } : {}) })]);
const answered = (id: string, over: Record<string, unknown> = {}) => result(id, "explain", { kind: "explain", tool: "explain", dontKnow: false, text: "2x sin x + x^2 cos x", ...over });
const finalCall = (id: string) => assistant([call(id, "explain", { type: "final", nodeId: "n", lead: "Last one.", question: "Differentiate x^4 sin(x^3).", correctAnswer: "4x^3 sin(x^3) + 3x^6 cos(x^3)" })]);
const finish = (id: string) => assistant([call(id, "finish_lesson", { summary: "Solved the final problem alone." })]);

describe("the recall question type", () => {
	it("is recognised, arrives open, and has no hint", () => {
		assert.equal(normalizeQuizType("recall"), "recall");
		assert.equal(questionNeedsReveal("explain", { type: "recall" }, "teach"), false);
		assert.equal(hintEligible("explain", { type: "recall" }, "teach"), false);
	});

	it("needs a lesson, a learned prerequisite, and `skill` naming one", () => {
		const openers = [{ id: "sk_limits" }];
		assert.match(explainScopeProblem("checks", "recall") ?? "", /only for a course lesson/);
		assert.equal(explainScopeProblem("all", "recall", "sk_limits", openers), null);
		assert.equal(explainScopeProblem("finalOnly", "recall", "sk_limits", openers), null, "a multiple-choice lesson may open too");
		assert.match(explainScopeProblem("all", "recall", undefined, openers) ?? "", /needs `skill`: one of sk_limits/);
		assert.match(explainScopeProblem("all", "recall", "sk_other", openers) ?? "", /needs `skill`/);
		assert.match(explainScopeProblem("all", "recall", "sk_limits", []) ?? "", /no learned prerequisite/);
		assert.equal(explainScopeProblem("all", "check"), null);
	});

	it("the lesson's explain tool carries the skill field and the opener in its description", () => {
		const ctx = { chatId: "c", chatStore: { getChat: () => undefined }, jobStore: {}, spawn: () => {}, lesson: { skill: { id: "sk_a", name: "A" }, openerSkills: [{ id: "sk_limits", name: "Limits" }] } } as unknown as TeacherToolContext;
		for (const enabled of [{ quizMix: true }, { explain: true }, undefined]) {
			const explain = createTeacherTools(ctx, enabled as never).explain!;
			assert.match(explain.description, /recall/i, JSON.stringify(enabled));
			assert.ok("skill" in (explain.parameters as { properties: object }).properties);
		}
	});
});

describe("recallOpenersOf", () => {
	it("collects the answered openers before the finish, with the evidence the grader reads", () => {
		const messages = [
			opener("o1", "sk_limits"),
			answered("o1", { text: "", sketch: { id: "sk_1", pages: 1 }, thinking: "product rule" }),
			assistant([call("r1", "read_sketch", { sketchId: "sk_1", reading: "2x sin x + x^2 cos x" })]),
			result("r1", "read_sketch"),
			opener("o2", "sk_prod", "State lim sin x / x."),
			answered("o2", { dontKnow: true, text: undefined }),
			finalCall("f1"),
			answered("f1"),
			finish("fin"),
		];
		const found = recallOpenersOf(messages, "fin");
		assert.deepEqual(found.map((o) => [o.skill, o.callId]), [["sk_limits", "o1"], ["sk_prod", "o2"]]);
		assert.match(found[0]!.transcript, /RECALL QUESTION.*Differentiate x\^2 sin x/);
		assert.match(found[0]!.transcript, /COMMITTED CORRECT ANSWER.*2x sin x/);
		assert.match(found[0]!.transcript, /LEARNER.S ANSWER: \(handwritten: see the sketch read-back\)/);
		assert.match(found[0]!.transcript, /LEARNER.S THINKING: product rule/);
		assert.match(found[0]!.transcript, /SKETCH READ-BACK.*2x sin x/);
		assert.match(found[1]!.transcript, /pressed .I don.t know./);
	});

	it("leaves out an unanswered, refused, dismissed or skill-less opener, and the final problem itself", () => {
		const messages = [
			opener("o1", "sk_limits"),
			opener("o2", "sk_limits"), answered("o2", { dismissed: true }),
			opener("o3", undefined), answered("o3"),
			opener("o4", "sk_limits"), result("o4", "explain", null, true),
			finalCall("f1"), answered("f1"), finish("fin"),
		];
		assert.deepEqual(recallOpenersOf(messages, "fin"), []);
	});
});

describe("the lesson hook grades the openers on a finish that goes through", () => {
	afterEach(() => installPracticeGrader(null));
	const ctxOf = (list: LhMessage[]): AfterToolCallContext => {
		const message = list.at(-1) as unknown as { content: Array<{ id: string; type: string; name: string }> };
		return { assistantMessage: message, toolCall: message.content[0]!, args: {}, result: { content: [], details: null }, isError: false, context: { systemPrompt: "", messages: list } } as unknown as AfterToolCallContext;
	};
	const lesson = { skill: { id: "sk_a", name: "Chain rule" }, openerSkills: [{ id: "sk_limits", name: "Limits" }, { id: "sk_prod", name: "Product rule" }] };
	const messages = (): LhMessage[] => [opener("o1", "sk_limits"), answered("o1"), opener("o2", "sk_prod"), answered("o2", { dontKnow: true }), finalCall("f1"), answered("f1"), finish("fin")];

	it("each opener is rated on its own skill and rides the finish result", async () => {
		const seen: string[] = [];
		installPracticeGrader(async (input) => {
			const id = input.skills[0]!.id;
			seen.push(`${id}:${input.difficulty}`);
			return { grades: [{ skill: id, grade: id === "sk_a" ? "good" : id === "sk_limits" ? "easy" : "again" }] };
		});
		const out = await lessonGradeHook(lesson)(ctxOf(messages()));
		assert.deepEqual(out?.details, { grades: [{ skill: "sk_a", grade: "good" }], openers: [{ skill: "sk_limits", grade: "easy" }, { skill: "sk_prod", grade: "again" }] });
		assert.deepEqual(seen.sort(), ["sk_a:final problem of a lesson", "sk_limits:recall opener of a lesson", "sk_prod:recall opener of a lesson"]);
	});

	it("an opener the grader cannot rate adds nothing; a refused finish grades no opener", async () => {
		installPracticeGrader(async (input) => {
			const id = input.skills[0]!.id;
			if (id === "sk_prod") throw new Error("boom");
			return { grades: [{ skill: id, grade: "good" }] };
		});
		const out = await lessonGradeHook(lesson)(ctxOf(messages()));
		assert.deepEqual((out?.details as { openers: unknown }).openers, [{ skill: "sk_limits", grade: "good" }]);
		let openersGraded = 0;
		installPracticeGrader(async (input) => {
			if (input.skills[0]!.id !== "sk_a") openersGraded++;
			return { grades: [{ skill: "sk_a", grade: "again" }] };
		});
		const turnedBack = await lessonGradeHook(lesson)(ctxOf(messages()));
		assert.equal(turnedBack?.isError, true);
		assert.equal(openersGraded, 0);
	});
});

describe("the fold reads the opener grades as reviews of their skills", () => {
	const link = { courseId: "c", mode: "learn", skillIds: ["sk_a"] } as never;
	const lesson = (details: unknown): LhMessage[] => [finalCall("f1"), answered("f1"), finish("fin"), result("fin", "finish_lesson", details)];

	it("an opener becomes a solved event with its grade, never on the lesson's own skill, and bad entries are dropped", () => {
		const events = skillEventsOf(lesson({ grades: [{ skill: "sk_a", grade: "good" }], openers: [{ skill: "sk_limits", grade: "easy" }, { skill: "sk_a", grade: "easy" }, { skill: "sk_x", grade: "great" }, "nope"] }), link);
		assert.deepEqual(events.map((e) => [e.skillId, e.outcome, e.grade]), [["sk_a", "finished", "good"], ["sk_limits", "solved", "easy"]]);
		assert.equal(skillEventsOf(lesson({ grades: [{ skill: "sk_a", grade: "good" }] }), link).length, 1, "no openers, no extra events");
	});

	it("a missed opener on a learned skill lowers its memory below a good one", () => {
		const earlier = [
			{ skillId: "sk_limits", at: 1, outcome: "solved" as const, grade: "good" as const, placement: false },
			{ skillId: "sk_limits", at: 2 * 86_400_000, outcome: "solved" as const, grade: "good" as const, placement: false },
		];
		const stateAfter = (grade: string) => foldSkills([...earlier, ...skillEventsOf(lesson({ grades: [{ skill: "sk_a", grade: "good" }], openers: [{ skill: "sk_limits", grade }] }), link)], () => []).get("sk_limits")!;
		assert.ok(understandingOf(stateAfter("again")) < understandingOf(stateAfter("good")));
	});
});

describe("the prompt and Practice all", () => {
	it("the Learn section tells the tutor to open with recall questions on learned prerequisites, and none without", () => {
		const text = coursePromptSection("learn", "Calc", [{ id: "sk_a", name: "A", statement: "Do a", understanding: 0, learned: false, known: false, needsReview: false }]);
		assert.match(text, /OPENER:.*type "recall"/);
		assert.match(text, /no learned prerequisite, there is no opener/);
		assert.match(text, /FINISHING:/);
	});

	it("Practice all mixes its order (a copy, with every skill kept)", () => {
		const ids = ["a", "b", "c", "d", "e", "f"];
		let i = 0;
		const out = shuffled(ids, () => [0.9, 0.1, 0.5, 0.3, 0.7][i++ % 5]!);
		assert.deepEqual([...out].sort(), ids);
		assert.notDeepEqual(out, ids);
		assert.deepEqual(ids, ["a", "b", "c", "d", "e", "f"], "the input is untouched");
		assert.deepEqual(shuffled([]), []);
	});
});
