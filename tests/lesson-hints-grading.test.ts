/**
 * Hints taken on a lesson's earlier checks reach the lesson grader (owner, 2026-11-19): the block after the final
 * problem's lines, the one added grader sentence, and the cap that already applies in code.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AfterToolCallContext } from "@earendil-works/pi-agent-core";

import { lessonGradeHook } from "../src/agent/lesson-grade.ts";
import { installPracticeGrader } from "../src/agent/practice-grade.ts";
import { LESSON_HINTS_SENTENCE, graderInstructions, gradesForSkills } from "../src/agent/subagents/grader.ts";
import { lessonHintsBlock } from "../src/core/final-problem.ts";
import { toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { hintPageId, isHintPageId, isSketchId, newSketchId } from "../src/core/sketch.ts";
import { renderProblemSpan } from "../src/core/practice-grading.ts";
import { sketchIdsOf } from "../src/core/sketch-gate.ts";
import { readSketchTool } from "../src/agent/tools/sketch.ts";

const STAMPS = { api: "faux", provider: "test", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" };
let t = 5000;
const assistant = (content: unknown[]): LhMessage => ({ id: `m${t}`, role: "assistant", content, ...STAMPS, timestamp: t++ }) as unknown as LhMessage;
const result = (toolCallId: string, toolName: string, details: unknown = null): LhMessage =>
	({ id: `m${t}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], details, isError: false, timestamp: t++ }) as unknown as LhMessage;
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });

const check = (id: string, over: Record<string, unknown> = {}) => assistant([call(id, "explain", { type: "check", nodeId: "n1", lead: "x", question: "Find the error bound for sin x.", correctAnswer: "1/300", ...over })]);
const answer = (id: string, over: Record<string, unknown> = {}) => result(id, "explain", { kind: "explain", tool: "explain", questionText: "Find the error bound for sin x.", dontKnow: false, text: "1/300", ...over });
const next = (id: string, previous: string) => assistant([call(id, "explain", { type: "check", nodeId: "n2", previous, lead: "y", question: "Next?", correctAnswer: "z" })]);
const finalCall = assistant([call("fin", "explain", { type: "final", nodeId: "goal", lead: "Last.", question: "Final?", correctAnswer: "ok" })]);
const finalAnswer = result("fin", "explain", { kind: "explain", tool: "explain", dontKnow: false, text: "ok" });
const finish = assistant([call("f1", "finish_lesson", { summary: "Done." })]);

describe("lessonHintsBlock", () => {
	it("lists each Hint-button hint with its level, the check and how that check went", () => {
		const block = lessonHintsBlock([check("a"), answer("a", { hints: ["Look at the limits.", "The sum is symmetric."] }), next("b", "right"), finalCall, finalAnswer, finish], "f1");
		assert.match(block, /^HINTS ON EARLIER CHECKS OF THIS LESSON/);
		assert.match(block, /Check «Find the error bound for sin x\.», hint 1 of 3: Look at the limits\. The learner's answer to that check was: right\./);
		assert.match(block, /hint 2 of 3: The sum is symmetric\./);
	});

	it("says I don't know for a skipped check, and leaves the outcome out when the tutor never graded it", () => {
		assert.match(lessonHintsBlock([check("a"), answer("a", { hints: ["h"], dontKnow: true }), finish], "f1"), /was: I don't know\./);
		const none = lessonHintsBlock([check("a"), answer("a", { hints: ["h"] }), finish], "f1");
		assert.ok(none.includes("hint 1 of 3: h") && !/The learner's answer/.test(none));
	});

	it("is empty with no hints, and ignores a steered answer, the final problem and hints after the finish", () => {
		assert.equal(lessonHintsBlock([check("a"), answer("a"), finish], "f1"), "");
		assert.equal(lessonHintsBlock([check("a"), answer("a", { hints: ["h"], dismissed: true, steer: "my notation" }), finish], "f1"), "");
		assert.equal(lessonHintsBlock([finalCall, answer("fin", { hints: ["h"] }), finish], "f1"), "");
		assert.equal(lessonHintsBlock([finish, check("a"), answer("a", { hints: ["h"] })], "f1"), "");
	});
});

describe("the grader is told what lesson hints are, only when there are some", () => {
	it("adds the approved sentence to the Hints paragraph", () => {
		assert.ok(graderInstructions({ lessonHints: true }).includes("A slip hint never lowers a grade. " + LESSON_HINTS_SENTENCE));
		assert.ok(!graderInstructions({}).includes("HINTS ON EARLIER CHECKS"));
		assert.equal(graderInstructions({ lessonHints: true }).replace(" " + LESSON_HINTS_SENTENCE, ""), graderInstructions({}));
	});

	it("the weight it names caps the grade in code, and never down to again", () => {
		const skills = [{ id: "sk_a" }];
		const grade = (g: string, hint?: string) => gradesForSkills({ grades: [{ skill: "sk_a", grade: g, ...(hint ? { hint } : {}) }] } as never, skills)[0]?.grade;
		assert.equal(grade("easy", "nudge"), "good");
		assert.equal(grade("easy", "carry"), "hard");
		assert.equal(grade("good", "carry"), "hard");
		assert.equal(grade("good", "slip"), "good");
		assert.equal(grade("hard", "carry"), "hard");
	});
});

describe("the finish hook", () => {
	afterEach(() => installPracticeGrader(null));
	const callOf = (messages: LhMessage[]) => ({ toolCall: { name: "finish_lesson", id: "f1" }, assistantMessage: messages[messages.length - 1], isError: false, context: { messages } }) as unknown as AfterToolCallContext;

	it("sends the grader the hints block and the flag, and nothing extra when there were no hints", async () => {
		let seen: { transcript?: string; lessonHints?: boolean } = {};
		installPracticeGrader(async (input) => {
			seen = input;
			return { grades: [{ skill: "sk_a", grade: "good" }] };
		});
		await lessonGradeHook({ skill: { id: "sk_a", name: "A" } })(callOf([check("a"), answer("a", { hints: ["Look at the limits."] }), next("b", "right"), finalCall, finalAnswer, finish]));
		assert.match(seen.transcript ?? "", /FINAL PROBLEM[\s\S]*HINTS ON EARLIER CHECKS[\s\S]*Look at the limits\./);
		assert.equal(seen.lessonHints, true);
		await lessonGradeHook({ skill: { id: "sk_a", name: "A" } })(callOf([check("a"), answer("a"), next("b", "right"), finalCall, finalAnswer, finish]));
		assert.ok(!/HINTS ON EARLIER/.test(seen.transcript ?? ""));
		assert.equal(seen.lessonHints, undefined);
	});
});

describe("the pages the hints were written from (owner, 2026-11-19)", () => {
	const img = { data: "AAAA", mimeType: "image/png" };
	const resolver = (calls: string[] = []) => (id: string, n: number) => {
		calls.push(`${id}/${n}`);
		return [img, img];
	};
	const hinted = (extra: Record<string, unknown> = {}) => [check("a"), answer("a", { hints: ["Look at the limits.", "The sum is symmetric."], ...extra })];
	const contentOf = (messages: LhMessage[], hintPages?: ReturnType<typeof resolver>) => {
		const llm = toLlmMessages(messages as never, hintPages ? { hintPages } : {});
		return (llm.find((m) => m.role === "toolResult")!.content as Array<{ type: string; text?: string }>);
	};
	const readHint = (sketchId: string, reading = "x_0 = 0.1, h = 0.2") => assistant([call("rs1", "read_sketch", { sketchId, reading, uncertain: ["the exponent"] })]);

	it("ids are sketch-shaped, one per hint, and never a real sketch's", () => {
		const id1 = hintPageId("toolu_01SCspJ1mqiE5sGEnos4hHCi", 1);
		assert.ok(isHintPageId(id1) && isSketchId(id1));
		assert.notEqual(id1, hintPageId("toolu_01SCspJ1mqiE5sGEnos4hHCi", 2));
		assert.notEqual(id1, hintPageId("toolu_other", 1));
		assert.equal(isHintPageId(newSketchId()), false);
	});

	it("read_sketch may name the page of each hint taken, but not of a steered answer or an unhinted one", () => {
		assert.ok(sketchIdsOf(hinted() as never).has(hintPageId("a", 1)) && sketchIdsOf(hinted() as never).has(hintPageId("a", 2)));
		assert.ok(!sketchIdsOf(hinted() as never).has(hintPageId("a", 3)));
		assert.ok(!sketchIdsOf(hinted({ dismissed: true, steer: "x" }) as never).has(hintPageId("a", 1)));
		assert.ok(!sketchIdsOf([check("a"), answer("a")] as never).has(hintPageId("a", 1)));
	});

	it("each kept page rides the hinted answer under a sketch-shaped label, the first with the instruction", () => {
		const calls: string[] = [];
		const content = contentOf(hinted(), resolver(calls));
		const labels = content.filter((b) => b.type === "text" && /^\[sketch sk_h/.test(b.text ?? "")).map((b) => b.text!);
		assert.equal(labels.length, 4, "two hints, two pages each");
		assert.ok(labels[0]!.startsWith(`[sketch ${hintPageId("a", 1)} · page 1/2] This page shows the learner's work at the moment they took hint 1 of 2`));
		assert.ok(!labels[1]!.includes("This page shows"));
		assert.equal(content.filter((b) => b.type === "image").length, 4);
		assert.deepEqual(calls, ["a/1", "a/2"]);
	});

	it("adds nothing with no resolver, no kept pages, a steered answer, or once the tutor has read that page", () => {
		assert.equal(contentOf(hinted()).length, 1);
		assert.equal(contentOf(hinted(), () => []).length, 1);
		assert.equal(contentOf(hinted({ dismissed: true, steer: "x" }), resolver()).length, 1);
		const afterRead = contentOf([...hinted(), readHint(hintPageId("a", 1))], resolver());
		assert.equal(afterRead.filter((b) => b.type === "image").length, 2, "hint 2's pages still ride");
		assert.ok(!afterRead.some((b) => (b.text ?? "").includes(hintPageId("a", 1))));
	});

	it("a read of a hint page never ends the turn, whatever doubts it lists", async () => {
		const tool = readSketchTool({ known: () => new Set([hintPageId("a", 1)]) });
		const res = await tool.execute("c", { sketchId: hintPageId("a", 1), reading: "x", uncertain: ["a sign"] } as never, undefined as never);
		assert.equal((res as { terminate?: boolean }).terminate, undefined);
		assert.equal((res.details as { doubts: number }).doubts, 0);
		const real = await readSketchTool({ known: () => new Set(["sk_0123456789abcdef"]) }).execute("c", { sketchId: "sk_0123456789abcdef", reading: "x", uncertain: ["a sign"] } as never, undefined as never);
		assert.equal((real as { terminate?: boolean }).terminate, true);
	});

	it("the grader's block adds what the tutor read on the page of each hint", () => {
		const block = lessonHintsBlock([...hinted(), readHint(hintPageId("a", 1), "x_0 = 0.1,   h = 0.2"), next("b", "right"), finish], "f1");
		assert.match(block, /hint 1 of 3: Look at the limits\. Work on the page when this hint was taken: x_0 = 0\.1, h = 0\.2\./);
		assert.ok(!/hint 2 of 3: [^\n]*Work on the page/.test(block));
	});
});

describe("practice hints show their pages too", () => {
	const img = { data: "AAAA", mimeType: "image/png" };
	const marker = (n: number) => ({ id: `h${n}`, role: "custom", customType: "practice-hint", content: `Hint ${n}: x`, display: true, details: { problemCallId: "p1", n, size: "nudge", text: `Hint text ${n}` }, timestamp: t++ }) as unknown as LhMessage;
	const pose = assistant([call("p1", "problem", { mode: "practice", statement: "Solve it.", modelSolution: "42", skills: ["sk_a"] })]);
	const userContent = (messages: LhMessage[], hintPages?: (id: string, n: number) => { data: string; mimeType: string }[]) => {
		const llm = toLlmMessages(messages as never, hintPages ? { hintPages } : {});
		return llm.filter((m) => m.role === "user").flatMap((m) => m.content as Array<{ type: string; text?: string }>);
	};

	it("read_sketch may name each practice hint's page", () => {
		const ids = sketchIdsOf([pose, marker(1), marker(2)] as never);
		assert.ok(ids.has(hintPageId("p1", 1)) && ids.has(hintPageId("p1", 2)) && !ids.has(hintPageId("p1", 3)));
	});

	it("each kept page rides its hint marker's message until the tutor has read it", () => {
		const calls: string[] = [];
		const resolver = (id: string, n: number) => (calls.push(`${id}/${n}`), [img]);
		const content = userContent([pose, marker(1), marker(2)], resolver);
		const labels = content.filter((b) => /^\[sketch sk_h/.test(b.text ?? ""));
		assert.equal(labels.length, 2);
		assert.ok(labels[0]!.text!.includes("hint 1 of 2") && labels[1]!.text!.includes("hint 2 of 2"));
		assert.equal(content.filter((b) => b.type === "image").length, 2);
		const read = assistant([call("rs", "read_sketch", { sketchId: hintPageId("p1", 1), reading: "y", uncertain: [] })]);
		assert.equal(userContent([pose, marker(1), marker(2), read], resolver).filter((b) => b.type === "image").length, 1);
		assert.equal(userContent([pose, marker(1)]).filter((b) => b.type === "image").length, 0, "no resolver, no pages");
	});

	it("the grader's HINT BY BUTTON line carries what the tutor read on that hint's page", () => {
		const read = assistant([call("rs", "read_sketch", { sketchId: hintPageId("p1", 2), reading: "x =  3", uncertain: [] })]);
		const text = renderProblemSpan([pose, marker(1), marker(2), read], "c1");
		assert.match(text, /HINT BY BUTTON \(size nudge[^\n]*Hint text 2 Work on the page when this hint was taken: x = 3\./);
		assert.ok(!/Hint text 1 Work on the page/.test(text));
	});
});
