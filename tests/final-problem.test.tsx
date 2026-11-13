/**
 * THE FINAL PROBLEM (owner, 2026-11-13 — core/final-problem.ts): a course
 * lesson ends with one unaided free-form problem. The `final` question type,
 * the explain tool's scope per quizzing mechanic, the finish gate, the span
 * the grader reads, the finish grading hook, and how the fold reads the grade.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";
import { renderToStaticMarkup } from "react-dom/server";

import { lessonGradeHook } from "../src/agent/lesson-grade.ts";
import { installPracticeGrader } from "../src/agent/practice-grade.ts";
import { createTeacherTools, explainScopeProblem, type TeacherToolContext } from "../src/agent/tools.ts";
import { isFinishRequest, newLessonFinishedMarker } from "../src/core/course-session.ts";
import {
	FINISH_GATE_REASON_DONT_KNOW,
	FINISH_GATE_REASON_NONE,
	FINISH_NOT_PASSED_TEXT,
	finalProblemSpanOf,
	finishGateProblem,
	finishGateReason,
	lastFinalProblemOf,
	renderFinalProblemSpan,
} from "../src/core/final-problem.ts";
import { foldSkills, skillEventsOf, understandingOf } from "../src/core/mastery.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { normalizeQuizType, questionNeedsReveal } from "../src/core/question-core.ts";
import { LessonFinishedLine } from "../components/lesson-finish.tsx";

const STAMPS = { api: "faux", provider: "test", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" };
let t = 1000;
const assistant = (content: unknown[]): LhMessage => ({ id: `m${t}`, role: "assistant", content, ...STAMPS, timestamp: t++ }) as unknown as LhMessage;
const result = (toolCallId: string, toolName: string, details: unknown = null, isError = false): LhMessage =>
	({ id: `m${t}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp: t++ }) as unknown as LhMessage;
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });

const finalCall = (id: string) => assistant([call(id, "explain", { type: "final", nodeId: "goal", lead: "Last one.", question: "Solve y'' + y = 0, y(0)=1, y'(0)=0.", correctAnswer: "y = cos x" })]);
const answered = (id: string, over: Record<string, unknown> = {}) => result(id, "explain", { kind: "explain", tool: "explain", dontKnow: false, text: "y = cos x", ...over });
const finish = (id: string) => assistant([{ type: "text", text: "Right: both constants found." }, call(id, "finish_lesson", { summary: "Solved it alone." })]);

describe("the final question type", () => {
	it("is recognised, and arrives open like a prediction", () => {
		assert.equal(normalizeQuizType("final"), "final");
		assert.equal(questionNeedsReveal("explain", { type: "final" }, "teach"), false);
		assert.equal(questionNeedsReveal("explain", { type: "check" }, "teach"), true);
	});

	it("explain's scope: checks only, everything, or the final problem alone", () => {
		assert.equal(explainScopeProblem("checks", "check"), null);
		assert.match(explainScopeProblem("checks", "final") ?? "", /only for a course lesson/);
		assert.equal(explainScopeProblem("all", "final"), null);
		assert.equal(explainScopeProblem("all", "predict"), null);
		assert.equal(explainScopeProblem("finalOnly", "final"), null);
		assert.match(explainScopeProblem("finalOnly", "check") ?? "", /only for the final problem/);
	});

	it("a course lesson always has explain: beside quiz in a multiple-choice lesson, alone in a free-recall one", () => {
		const ctx = { chatId: "c", chatStore: { getChat: () => undefined }, jobStore: {}, spawn: () => {} } as unknown as TeacherToolContext;
		const lesson = { skill: { id: "sk_a", name: "A" } };
		const names = (c: TeacherToolContext, enabled?: Record<string, boolean>) => Object.keys(createTeacherTools(c, enabled)).filter((n) => n === "quiz" || n === "explain").sort();
		assert.deepEqual(names(ctx), ["quiz"]);
		assert.deepEqual(names({ ...ctx, lesson }), ["explain", "quiz"]);
		assert.deepEqual(names(ctx, { explain: true }), ["explain"]);
		assert.deepEqual(names({ ...ctx, lesson }, { explain: true }), ["explain"]);
		const tools = createTeacherTools({ ...ctx, lesson });
		assert.match(tools.explain!.description, /FINAL PROBLEM/);
		assert.match(tools.explain!.description, /`type` must be final/);
	});
});

describe("the finish gate", () => {
	it("refuses a finish with no final problem, an unanswered one, or one from before the last finish attempt", () => {
		assert.equal(finishGateProblem([], "finish_lesson", "f1"), "none");
		assert.equal(finishGateProblem([finalCall("x1"), result("x1", "explain")], "finish_lesson", "f1"), "none", "posed, not answered");
		const refusedOnce = [finalCall("x1"), answered("x1"), finish("f1"), result("f1", "finish_lesson", null, true)];
		assert.equal(finishGateProblem(refusedOnce, "finish_lesson", "f2"), "none", "the old final problem is spent");
		assert.equal(finishGateProblem([...refusedOnce, finalCall("x2"), answered("x2")], "finish_lesson", "f2"), null);
	});

	it("lets a finish through after an answered final problem, whether or not the calling message is in the history", () => {
		const history = [finalCall("x1"), answered("x1")];
		assert.equal(finishGateProblem(history, "finish_lesson", "f1"), null);
		assert.equal(finishGateProblem([...history, finish("f1")], "finish_lesson", "f1"), null);
	});

	it("refuses when the learner did not know, and ignores every other tool and question type", () => {
		assert.equal(finishGateProblem([finalCall("x1"), answered("x1", { dontKnow: true, text: undefined })], "finish_lesson", "f1"), "dontKnow");
		assert.equal(finishGateProblem([], "quiz", "q1"), null);
		const check = assistant([call("e1", "explain", { type: "check", nodeId: "n", lead: "l", question: "q", correctAnswer: "a" })]);
		assert.equal(finishGateProblem([check, answered("e1")], "finish_lesson", "f1"), "none", "a check is not a final problem");
		assert.equal(finishGateReason("none"), FINISH_GATE_REASON_NONE);
		assert.equal(finishGateReason("dontKnow"), FINISH_GATE_REASON_DONT_KNOW);
	});

	it("finds the newest answered final problem", () => {
		const messages = [finalCall("x1"), answered("x1", { dontKnow: true }), finalCall("x2"), answered("x2")];
		assert.deepEqual(lastFinalProblemOf(messages), { index: 2, callId: "x2", dontKnow: false });
		assert.equal(lastFinalProblemOf([finalCall("x1")]), null);
	});
});

describe("the grader's span", () => {
	const record = (): LhMessage[] => [
		assistant([call("q1", "quiz", { type: "check", nodeId: "n", lead: "earlier", question: "earlier question", options: [], correctAnswer: "a" })]),
		result("q1", "quiz", { kind: "quiz", correct: true }),
		finalCall("x1"),
		answered("x1", { text: "", sketch: { id: "sk_1", pages: 1 }, thinking: "roots are plus/minus i" }),
		assistant([call("r1", "read_sketch", { sketchId: "sk_1", reading: "y = cos x", uncertain: [] })]),
		result("r1", "read_sketch"),
		finish("f1"),
	];

	it("runs from the final problem through the finish call and leaves the lesson before it out", () => {
		const span = finalProblemSpanOf(record(), "f1");
		assert.equal(span.length, 5);
		assert.deepEqual(finalProblemSpanOf(record(), "nope"), []);
		assert.deepEqual(finalProblemSpanOf([finish("f1")], "f1"), [], "no final problem before the finish");
	});

	it("renders the problem, the commitment, the learner's answer and thinking, the read-back, the tutor and the summary", () => {
		const text = renderFinalProblemSpan(finalProblemSpanOf(record(), "f1"), "f1");
		assert.match(text, /FINAL PROBLEM \(posed with no hints; the learner works alone\): Solve y'' \+ y = 0/);
		assert.match(text, /COMMITTED CORRECT ANSWER.*y = cos x/);
		assert.match(text, /LEARNER'S ANSWER: \(handwritten: see the sketch read-back\)/);
		assert.match(text, /LEARNER'S THINKING: roots are plus\/minus i/);
		assert.match(text, /SKETCH READ-BACK.*y = cos x/);
		assert.match(text, /TUTOR: Right: both constants found\./);
		assert.match(text, /TUTOR'S FINISH SUMMARY: Solved it alone\./);
		assert.ok(!text.includes("earlier question"));
	});

	it("says when the learner did not know", () => {
		const messages = [finalCall("x1"), answered("x1", { dontKnow: true, text: undefined }), finish("f1")];
		assert.match(renderFinalProblemSpan(finalProblemSpanOf(messages, "f1"), "f1"), /LEARNER: pressed "I don't know"\./);
	});
});

describe("the lesson grade hook", () => {
	afterEach(() => installPracticeGrader(null));
	const skill = { id: "sk_a", name: "Alpha" };
	const messages = (): LhMessage[] => [finalCall("x1"), answered("x1"), finish("f1")];
	const callOf = (list: LhMessage[], toolName = "finish_lesson", isError = false): AfterToolCallContext => {
		const message = list.at(-1) as unknown as { content: Array<{ id: string; type: string; name: string }> };
		const toolCall = message.content.find((b) => b.type === "toolCall")!;
		return { assistantMessage: message, toolCall: { ...toolCall, name: toolName }, args: {}, result: { content: [], details: null }, isError, context: { systemPrompt: "", messages: list } } as unknown as AfterToolCallContext;
	};

	it("grades the final problem for the lesson's skill and writes the grade into the finish result", async () => {
		let seen: { skills?: unknown; transcript?: string; session?: unknown } = {};
		const sessionModel = { provider: "anthropic", id: "claude-sonnet-5-5" };
		installPracticeGrader(async (input, _signal, session) => {
			seen = { ...input, session };
			return { grades: [{ skill: "sk_a", grade: "good" }] };
		});
		const out = await lessonGradeHook({ skill, sessionModel })(callOf(messages()));
		assert.deepEqual(out, { details: { grades: [{ skill: "sk_a", grade: "good" }] } });
		assert.deepEqual(seen.skills, [skill]);
		assert.match(seen.transcript ?? "", /FINAL PROBLEM/);
		assert.deepEqual(seen.session, sessionModel);
	});

	it("again turns the finish back: an error result telling the teacher to repair and pose a new final problem", async () => {
		installPracticeGrader(async () => ({ grades: [{ skill: "sk_a", grade: "again" }] }));
		const out = await lessonGradeHook({ skill })(callOf(messages()));
		assert.equal(out?.isError, true);
		assert.deepEqual(out?.content, [{ type: "text", text: FINISH_NOT_PASSED_TEXT }]);
		assert.deepEqual(out?.details, { grades: [{ skill: "sk_a", grade: "again" }] });
	});

	it("a fallback grading and a failed one keep their note; the finish stands", async () => {
		installPracticeGrader(async () => ({ grades: [{ skill: "sk_a", grade: "hard" }], gradedBy: "session", gradeError: "out of credit (Google)" }));
		assert.deepEqual(await lessonGradeHook({ skill })(callOf(messages())), { details: { grades: [{ skill: "sk_a", grade: "hard" }], gradedBy: "session", gradeError: "out of credit (Google)" } });
		installPracticeGrader(async () => ({ grades: [], gradeError: "out of credit (Google)" }));
		assert.deepEqual(await lessonGradeHook({ skill })(callOf(messages())), { details: { grades: [], gradeError: "out of credit (Google)" } });
	});

	it("does nothing for other tools, a refused finish, a finish with no final problem, or with no grader installed", async () => {
		installPracticeGrader(async () => ({ grades: [{ skill: "sk_a", grade: "good" }] }));
		assert.equal(await lessonGradeHook({ skill })(callOf(messages(), "quiz")), undefined);
		assert.equal(await lessonGradeHook({ skill })(callOf(messages(), "finish_lesson", true)), undefined);
		assert.equal(await lessonGradeHook({ skill })(callOf([finish("f1")])), undefined);
		installPracticeGrader(null);
		assert.equal(await lessonGradeHook({ skill })(callOf(messages())), undefined);
	});
});

describe("the fold reads the finish's grade", () => {
	const link = { courseId: "c", mode: "learn", skillIds: ["sk_a"] } as never;
	const lesson = (details: unknown, isError = false): LhMessage[] => [finalCall("x1"), answered("x1"), finish("f1"), result("f1", "finish_lesson", details, isError)];
	const gradeOf = (details: unknown) => skillEventsOf(lesson(details), link)[0]?.grade;

	it("the grader's grade is the skill's first rating; a grading with no grade counts as hard; an old finish keeps good", () => {
		assert.equal(gradeOf({ grades: [{ skill: "sk_a", grade: "easy" }] }), "easy");
		assert.equal(gradeOf({ grades: [] }), "hard");
		assert.equal(gradeOf({ grades: [], gradeError: "x" }), "hard");
		assert.equal(gradeOf(null), undefined, "the default (good) applies");
		const understanding = (details: unknown) => understandingOf(foldSkills(skillEventsOf(lesson(details), link), () => []).get("sk_a")!);
		assert.ok(understanding({ grades: [{ skill: "sk_a", grade: "hard" }] }) < understanding(null));
		assert.ok(understanding(null) < understanding({ grades: [{ skill: "sk_a", grade: "easy" }] }));
	});

	it("a finish the grader turned back is no finish: the skill stays not learned", () => {
		assert.deepEqual(skillEventsOf(lesson({ grades: [{ skill: "sk_a", grade: "again" }] }, true), link), []);
	});
});

describe("the learner's Finish press in a lesson", () => {
	it("is a request marker, and renders as its own divider", () => {
		const marker = newLessonFinishedMarker("learn");
		assert.equal(isFinishRequest(marker), true);
		assert.match(String(marker.content), /^\[FINISH REQUESTED\]/);
		assert.equal(isFinishRequest(newLessonFinishedMarker("practice")), false);
		const html = renderToStaticMarkup(<LessonFinishedLine skill="Chain rule" request />);
		assert.match(html, /Finish requested · final problem next/);
		assert.ok(!html.includes("learned"));
		assert.match(renderToStaticMarkup(<LessonFinishedLine skill="Chain rule" />), /Lesson finished · Chain rule learned/);
	});
});
