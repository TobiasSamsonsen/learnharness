/**
 * A teach question's `lead` is the tutor's prose (owner, 2026-10-27): the one
 * helper, the schema, the view projection, and every consumer that reads
 * "what the tutor said" (coverage, export, dictation vocabulary, the
 * compaction summary).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { leadOf, tutorProse } from "../src/core/tutor-prose.ts";
import { explainInputObject, explainDisplayInputSchema, quizDisplayInputSchema, quizInputObject } from "../src/core/question-core.ts";
import { projectView } from "../src/core/view.ts";
import { messageViewLines, teacherProseBlocks } from "../src/core/coverage.ts";
import { messageMarkdown } from "../src/core/session-markdown.ts";
import { serializeForSummary } from "../src/core/compaction.ts";
import { dictationVocabulary } from "../src/core/dictation-vocabulary.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const quizBase = {
	type: "check",
	nodeId: "n1",
	question: "Which spring force is zero at rest?",
	explanation: "Zero displacement, zero force.",
	options: [
		{ label: "$0$", value: "a" },
		{ label: "$k$", value: "b" },
	],
	correctAnswer: "a",
};
const call = (id: string, lead?: string, name = "quiz") => ({
	type: "toolCall" as const,
	id,
	name,
	arguments: lead === undefined ? quizBase : { ...quizBase, lead },
});
const assistant = (id: string, content: unknown[]): LhMessage =>
	({ id, role: "assistant", content, timestamp: 1, api: "x", provider: "x", model: "x", usage: {}, stopReason: "toolUse" }) as never;
const toolResult = (toolCallId: string, isError: boolean): LhMessage =>
	({ id: `r-${toolCallId}`, role: "toolResult", toolCallId, toolName: "quiz", content: [{ type: "text", text: "x" }], isError, timestamp: 2 }) as never;

describe("leadOf / tutorProse", () => {
	it("a quiz or explain call's non-blank lead is prose; others are not", () => {
		assert.equal(leadOf(call("c1", "Right: …")), "Right: …");
		assert.equal(leadOf(call("c2", "Right: …", "explain")), "Right: …");
		assert.equal(leadOf(call("c3", "   ")), "");
		assert.equal(leadOf(call("c4")), "");
		assert.equal(leadOf(call("c5", "x", "probe")), "", "probe carries no lead");
		assert.equal(leadOf({ type: "text", text: "hi" }), "");
	});

	it("keeps text blocks and leads in order, skipping blanks and rejected calls", () => {
		const content = [{ type: "text", text: "First." }, call("c1", "Second."), call("c2", "Third."), { type: "text", text: "  " }];
		assert.deepEqual(tutorProse(content), ["First.", "Second.", "Third."]);
		assert.deepEqual(tutorProse(content, new Set(["c2"])), ["First.", "Second."]);
	});
});

describe("the teach schemas require a lead; the display parse does not", () => {
	it("quiz and explain: required, non-empty", () => {
		const ok = { ...quizBase, lead: "Right: …" };
		assert.equal(Value.Check(quizInputObject, ok), true);
		assert.equal(Value.Check(quizInputObject, quizBase), false, "no lead");
		assert.equal(Value.Check(quizInputObject, { ...quizBase, lead: "" }), false, "empty lead");
		const explain = { type: "check", nodeId: "n1", lead: "Right: …", question: "Why?", correctAnswer: "Because." };
		assert.equal(Value.Check(explainInputObject, explain), true);
		const { lead: _lead, ...bare } = explain;
		assert.equal(Value.Check(explainInputObject, bare), false);
	});

	it("old records without a lead still parse for display, and a lead is kept", () => {
		assert.equal(Value.Check(quizDisplayInputSchema, quizBase), true);
		assert.equal(Value.Check(explainDisplayInputSchema, { question: "Why?", correctAnswer: "Because." }), true);
		const cleaned = Value.Clean(quizDisplayInputSchema, structuredClone({ ...quizBase, lead: "Right: …" })) as { lead?: string };
		assert.equal(cleaned.lead, "Right: …");
	});
});

describe("projectView shows a lead as ordinary tutor text", () => {
	const user: LhMessage = { id: "u1", role: "user", content: "hi", timestamp: 0 } as never;

	it("a text part right above the question's tool part", () => {
		const view = projectView([user, assistant("a1", [call("c1", "Right: it is zero.")])]);
		const types = view[1]!.parts.map((p) => p.type);
		assert.deepEqual(types, ["step-start", "text", "tool-quiz"]);
		assert.equal((view[1]!.parts[1] as { text: string }).text, "Right: it is zero.");
	});

	it("text written before the call and the lead both show, in order", () => {
		const view = projectView([user, assistant("a1", [{ type: "text", text: "Intro." }, call("c1", "Right.")])]);
		assert.deepEqual(view[1]!.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text), ["Intro.", "Right."]);
	});

	it("a call that errored back shows no lead (a retry never stacks a second copy)", () => {
		const view = projectView([user, assistant("a1", [call("c1", "Right.")]), toolResult("c1", true)]);
		assert.equal(view[1]!.parts.filter((p) => p.type === "text").length, 0);
	});

	it("a blank lead or none projects nothing extra", () => {
		const view = projectView([user, assistant("a1", [call("c1", "  ")]), assistant("a2", [call("c2")])]);
		assert.equal(view[1]!.parts.filter((p) => p.type === "text").length, 0);
	});
});

describe("consumers that read the tutor's text see a lead", () => {
	const msg = assistant("a1", [{ type: "thinking", thinking: "private" }, call("c1", "Right: **zero** force at rest.")]);

	it("coverage / extraction: the lead is teacher prose", () => {
		assert.deepEqual(messageViewLines(msg, "a1"), ["TEACHER [a1] Right: **zero** force at rest."]);
		assert.deepEqual(teacherProseBlocks([msg]), ["Right: **zero** force at rest."]);
	});

	it("markdown export: the lead is under a Teacher heading", () => {
		const md = messageMarkdown(msg, "a1", false)!;
		assert.match(md, /### Teacher/);
		assert.match(md, /Right: \*\*zero\*\* force at rest\./);
	});

	it("compaction summary: said as prose, not buried in the call's JSON", () => {
		const text = serializeForSummary([msg]);
		assert.match(text, /\[TUTOR\] Right: \*\*zero\*\* force at rest\./);
		assert.ok(!/"lead"/.test(text), "the call's JSON no longer repeats it");
		assert.match(text, /\(tool call quiz: /);
	});

	it("dictation vocabulary: bold terms in a lead are recognised", () => {
		const vocab = dictationVocabulary({ messages: [msg], language: "en" as never });
		assert.match(vocab, /zero/);
	});
});
