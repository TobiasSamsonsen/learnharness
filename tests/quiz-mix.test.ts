/**
 * TUTOR DECIDES (owner, 2026-11-13): the third quizzing mechanic. The lesson
 * teacher carries both quiz and explain and picks the form per question; the
 * probe stays multiple choice. The stored keys, the default made explicit at
 * the chat-handler seam, and the registries.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { QUIZ_FORM_RULE, createProberTools, createTeacherTools, quizMechanics, type TeacherToolContext } from "../src/agent/tools.ts";
import { quizMechanicsSetting, withQuizDefault } from "../src/core/pending.ts";

const ctx = { chatId: "c", chatStore: { getChat: () => undefined }, jobStore: {}, spawn: () => {}, deliver: () => {} } as unknown as TeacherToolContext;
const quizzing = (tools: Record<string, unknown>) => Object.keys(tools).filter((n) => ["quiz", "explain", "probe", "recall"].includes(n)).sort();

describe("the quizzing setting", () => {
	it("reads three states from the two stored keys; absent is Tutor decides", () => {
		assert.equal(quizMechanicsSetting(undefined), "mixed");
		assert.equal(quizMechanicsSetting({}), "mixed");
		assert.equal(quizMechanicsSetting({ explain: false }), "mixed");
		assert.equal(quizMechanicsSetting({ quizMix: true }), "mixed");
		assert.equal(quizMechanicsSetting({ quizMix: false }), "choice");
		assert.equal(quizMechanicsSetting({ explain: true }), "free");
		assert.equal(quizMechanicsSetting({ explain: true, quizMix: true }), "free", "free recall wins");
	});

	it("the default is made explicit for the factories, which alone treat an absent key as multiple choice", () => {
		assert.deepEqual(withQuizDefault(undefined), { quizMix: true });
		assert.deepEqual(withQuizDefault({ research: false } as never), { research: false, quizMix: true });
		assert.deepEqual(withQuizDefault({ quizMix: false }), { quizMix: false });
		assert.deepEqual(withQuizDefault({ explain: true }), { explain: true, quizMix: false });
		assert.equal(quizMechanics(undefined), "choice");
		assert.equal(quizMechanics({}), "choice");
		assert.equal(quizMechanics(withQuizDefault(undefined)), "mixed");
		assert.equal(quizMechanics(withQuizDefault({ explain: true })), "free");
	});
});

describe("the registries under Tutor decides", () => {
	it("the teacher has both tools, each carrying the rule for choosing; other mechanics carry no rule", () => {
		const mixed = createTeacherTools(ctx, { quizMix: true } as never);
		assert.deepEqual(quizzing(mixed), ["explain", "quiz"]);
		assert.ok(mixed.quiz!.description.endsWith(QUIZ_FORM_RULE));
		assert.ok(mixed.explain!.description.endsWith(QUIZ_FORM_RULE));
		assert.match(QUIZ_FORM_RULE, /could he pick the right option by eliminating the others/);
		assert.ok(!createTeacherTools(ctx).quiz!.description.includes("CHOOSING THE FORM"));
		assert.ok(!createTeacherTools(ctx, { explain: true }).explain!.description.includes("CHOOSING THE FORM"));
	});

	it("in a course lesson the mixed explain also poses the final problem", async () => {
		const tools = createTeacherTools({ ...ctx, lesson: { skill: { id: "sk_a", name: "A" } } }, { quizMix: true } as never);
		assert.deepEqual(quizzing(tools), ["explain", "quiz"]);
		assert.match(tools.explain!.description, /`type` final poses the lesson's FINAL PROBLEM/);
		assert.ok(!tools.explain!.description.includes("`type` must be final"), "not the final-only tool");
	});

	it("the probe stays multiple choice", () => {
		assert.deepEqual(quizzing(createProberTools(ctx as never, { quizMix: true } as never)), ["probe"]);
		assert.deepEqual(quizzing(createProberTools(ctx as never, { explain: true })), ["recall"]);
	});
});
