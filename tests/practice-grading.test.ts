/**
 * THE PRACTICE GRADER (owner, 2026-11-09): a second model grades each tagged
 * skill of a concluded problem from its whole transcript. Pure span/render
 * logic, the afterToolCall hook (with a stub grader), and how the fold reads
 * the grades from the conclude result.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";

import { installPracticeGrader, practiceGradeHook } from "../src/agent/practice-grade.ts";
import { gradesForSkills, graderPrompt } from "../src/agent/subagents/grader.ts";
import { concludeGradesOf, foldSkills, skillEventsOf, understandingOf } from "../src/core/mastery.ts";
import { problemSpanOf, renderProblemSpan, taggedSkillsOf } from "../src/core/practice-grading.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const STAMPS = { api: "faux", provider: "test", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" };
let t = 1000;
const assistant = (content: unknown[]): LhMessage => ({ role: "assistant", content, ...STAMPS, timestamp: t++ }) as unknown as LhMessage;
const result = (toolCallId: string, toolName: string, details: unknown = null, isError = false): LhMessage =>
	({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp: t++ }) as unknown as LhMessage;
const thinking = (text: string, confidence = 30): LhMessage =>
	({ id: `m${t}`, role: "custom", customType: "practice-thinking", content: `Your thinking:\n${text}\n\n[Confidence: ${confidence}% — how sure the learner says they are of this answer.]`, display: true, timestamp: t++ }) as unknown as LhMessage;

const pose = (id: string, skills: string[]): LhMessage[] => [
	assistant([{ type: "toolCall", id, name: "problem", arguments: { statement: "Solve y' + y = 1", mode: "recall", modelSolution: "y = 1 + Ce^{-x}", skills } }]),
	result(id, "problem"),
];
const concludeCall = (id: string, args: Record<string, unknown> = {}): LhMessage =>
	assistant([{ type: "toolCall", id, name: "conclude", arguments: { outcome: "solvedWithHints", verdict: "Fixed after a hint.", rung: "R1", missClass: "execution", retest: false, ...args } }]);

/** An earlier concluded problem, then the one under test. */
const record = (): LhMessage[] => [
	...pose("old", ["sk_old"]),
	concludeCall("oldc"),
	result("oldc", "conclude"),
	...pose("p1", ["sk_a", "sk_b"]),
	thinking("I think y = 1"),
	assistant([{ type: "text", text: "Check the constant." }]),
	thinking("(no words)", 70),
	assistant([{ type: "toolCall", id: "r1", name: "read_sketch", arguments: { sketchId: "sk_1", reading: "y=1+Ce^{-x}", uncertain: [] } }]),
	result("r1", "read_sketch"),
	concludeCall("c1"),
];

describe("problem span", () => {
	it("runs from the newest clean pose through the conclude call, leaving earlier problems out", () => {
		const span = problemSpanOf(record(), "c1");
		assert.equal((span[0] as { content: Array<{ id: string }> }).content[0]!.id, "p1");
		assert.equal((span.at(-1) as unknown as { content: Array<{ id: string }> }).content[0]!.id, "c1");
		assert.deepEqual(taggedSkillsOf(span), ["sk_a", "sk_b"]);
	});

	it("is empty when the conclude call is absent, and a refused pose does not open a span", () => {
		assert.deepEqual(problemSpanOf(record(), "nope"), []);
		const refused: LhMessage[] = [
			assistant([{ type: "toolCall", id: "bad", name: "problem", arguments: { skills: ["sk_x"] } }]),
			result("bad", "problem", null, true),
			concludeCall("c2"),
		];
		assert.deepEqual(problemSpanOf(refused, "c2"), []);
	});

	it("renders the problem, the committed solution, the learner's work with its confidence, the tutor, the read-back and the conclusion", () => {
		const text = renderProblemSpan(problemSpanOf(record(), "c1"), "c1");
		assert.match(text, /PROBLEM \(recall\): Solve y' \+ y = 1/);
		assert.match(text, /COMMITTED MODEL SOLUTION.*y = 1 \+ Ce\^\{-x\}/);
		assert.match(text, /LEARNER \(work submitted\):\nYour thinking:\nI think y = 1[\s\S]*Confidence: 30%/);
		assert.match(text, /TUTOR: Check the constant\./);
		assert.match(text, /SKETCH READ-BACK.*y=1\+Ce\^\{-x\}/);
		assert.match(text, /TUTOR'S CONCLUSION: outcome solvedWithHints, hint rung R1, miss class execution\. Verdict: Fixed after a hint\./);
		assert.ok(!text.includes("sk_old"), "an earlier problem is not in the evidence");
	});
});

describe("grader helpers", () => {
	it("keeps only listed skills, the last entry per skill, and leaves a skipped skill absent", () => {
		const grades = gradesForSkills(
			{ grades: [{ skill: "sk_a", grade: "good" }, { skill: "sk_a", grade: "hard" }, { skill: "sk_z", grade: "easy" }] },
			[{ id: "sk_a" }, { id: "sk_b" }],
		);
		assert.deepEqual(grades, [{ skill: "sk_a", grade: "hard" }]);
	});

	it("the prompt lists the skills and the problem size", () => {
		const prompt = graderPrompt({ skills: [{ id: "sk_a", name: "Alpha" }], transcript: "T", difficulty: "short" });
		assert.match(prompt, /PROBLEM SIZE: short/);
		assert.match(prompt, /- sk_a: Alpha/);
	});
});

describe("the practice grade hook", () => {
	afterEach(() => installPracticeGrader(null));
	const skills = () => [{ id: "sk_a", name: "Alpha" }, { id: "sk_b", name: "Beta" }];
	const callOf = (messages: LhMessage[], toolName = "conclude", isError = false): AfterToolCallContext => {
		const message = messages.at(-1) as unknown as { content: Array<{ id: string; type: string; name: string }> };
		const toolCall = message.content.find((b) => b.type === "toolCall")!;
		return { assistantMessage: message, toolCall: { ...toolCall, name: toolName }, args: {}, result: { content: [], details: null }, isError, context: { systemPrompt: "", messages } } as unknown as AfterToolCallContext;
	};

	it("grades the live span and writes the grades into the result's details", async () => {
		let seen = "";
		installPracticeGrader(async (input) => {
			seen = input.transcript;
			assert.deepEqual(input.skills, [{ id: "sk_a", name: "Alpha" }, { id: "sk_b", name: "Beta" }]);
			return [{ skill: "sk_a", grade: "hard" }, { skill: "sk_b", grade: "good" }];
		});
		const out = await practiceGradeHook({ courseSkills: skills })(callOf(record()));
		assert.deepEqual(out, { details: { grades: [{ skill: "sk_a", grade: "hard" }, { skill: "sk_b", grade: "good" }] } });
		assert.match(seen, /SKETCH READ-BACK/, "the read-back from the same turn is in the evidence");
	});

	it("adds the assistant message when the live list does not hold it yet", async () => {
		installPracticeGrader(async () => [{ skill: "sk_a", grade: "good" }]);
		const messages = record();
		const ctx = callOf(messages);
		const out = await practiceGradeHook({ courseSkills: skills })({ ...ctx, context: { ...ctx.context, messages: messages.slice(0, -1) } as never });
		assert.deepEqual(out, { details: { grades: [{ skill: "sk_a", grade: "good" }] } });
	});

	it("a grader failure records no grades, so the outcome's default applies", async () => {
		installPracticeGrader(async () => {
			throw new Error("boom");
		});
		const original = console.warn;
		console.warn = () => {};
		try {
			assert.deepEqual(await practiceGradeHook({ courseSkills: skills })(callOf(record())), { details: { grades: [] } });
		} finally {
			console.warn = original;
		}
	});

	it("does nothing outside a course session, for other tools, for a refused conclude, or with no grader installed", async () => {
		installPracticeGrader(async () => [{ skill: "sk_a", grade: "good" }]);
		assert.equal(await practiceGradeHook({})(callOf(record())), undefined);
		assert.equal(await practiceGradeHook({ courseSkills: skills })(callOf(record(), "read_sketch")), undefined);
		assert.equal(await practiceGradeHook({ courseSkills: skills })(callOf(record(), "conclude", true)), undefined);
		installPracticeGrader(null);
		assert.equal(await practiceGradeHook({ courseSkills: skills })(callOf(record())), undefined);
	});
});

describe("the fold reads the grader's grades", () => {
	it("result details win over the tutor's own grades; details with no grades never fall back to the tutor's", () => {
		const args = { grades: [{ skill: "sk_a", grade: "easy" }] };
		assert.equal(concludeGradesOf(args, { grades: [{ skill: "sk_a", grade: "hard" }] }).get("sk_a"), "hard");
		assert.equal(concludeGradesOf(args, { grades: [] }).get("sk_a"), undefined, "a failed grader falls to the outcome default, not the tutor");
		assert.equal(concludeGradesOf(args, null).get("sk_a"), "easy", "records from before the grader keep the tutor's grades");
	});

	it("a hint-assisted solve graded hard moves understanding less than the tutor's good", () => {
		const link = { courseId: "c", mode: "review", skillIds: ["sk_a", "sk_b"] } as never;
		const fold = (grade: string) => {
			const messages = [...pose("p1", ["sk_a"]), concludeCall("c1"), result("c1", "conclude", { grades: [{ skill: "sk_a", grade }] })];
			const states = foldSkills(skillEventsOf(messages, link), () => []);
			return understandingOf(states.get("sk_a")!);
		};
		assert.ok(fold("hard") < fold("good"));
		assert.ok(fold("good") < fold("easy"));
	});
});
