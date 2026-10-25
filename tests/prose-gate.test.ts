/**
 * The prose gate (owner, 2026-10-25 — the ITGK lesson: twenty teacher
 * turns went thinking → next quiz, the learner never saw a word of
 * teaching). The pure rule, then the live wiring through the teacher's
 * beforeToolCall.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { ANSWER_NEXT_TEXT, PROSE_GATE_REASON, proseGateBlocks } from "../src/core/prose-gate.ts";
import { newAnswerResult } from "../src/core/native-messages.ts";
import { bareQuestionTools, createPracticeAgent, createTeacherAgent } from "../src/agent/teacher-agent.ts";

const quizArgs = {
	type: "check",
	nodeId: "n1",
	question: "What is $2+2$?",
	explanation: "$2+2=4$.",
	options: [
		{ label: "$4$", value: "a" },
		{ label: "$5$", value: "b" },
	],
	correctAnswer: "a",
};

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "faux",
	provider: "faux",
	model: "faux",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse",
	timestamp: 1,
});
const call = (id: string, name = "quiz"): ToolCall => ({ type: "toolCall", id, name, arguments: quizArgs as ToolCall["arguments"] });
const text = (t: string) => ({ type: "text" as const, text: t });
const result = (toolCallId: string, toolName: string) => ({
	role: "toolResult" as const,
	toolCallId,
	toolName,
	content: [text('{"kind":"quiz","correct":false}')],
	isError: false,
	timestamp: 1,
});

/** A transcript that ends on the learner's graded answer to q1. */
const answered = [{ role: "user", content: "teach me", timestamp: 0 }, assistant([text("Step one."), call("q1")]), result("q1", "quiz")];

describe("proseGateBlocks (the pure rule)", () => {
	it("refuses a bare quiz right after a graded answer", () => {
		const next = assistant([call("q2")]);
		assert.equal(proseGateBlocks([...answered, next], next, "q2", "quiz"), true);
		assert.equal(proseGateBlocks(answered, next, "q2", "explain"), true, "free recall is gated too");
	});

	it("thinking is not prose", () => {
		const next = assistant([{ type: "thinking", thinking: "I'll show a table" }, call("q2")]);
		assert.equal(proseGateBlocks(answered, next, "q2", "quiz"), true);
	});

	it("text BEFORE the call in the same message passes; text only after it does not", () => {
		assert.equal(proseGateBlocks(answered, assistant([text("Not quite: …"), call("q2")]), "q2", "quiz"), false);
		assert.equal(proseGateBlocks(answered, assistant([call("q2"), text("afterthought")]), "q2", "quiz"), true);
	});

	it("text in an earlier message of the same turn passes", () => {
		const prior = assistant([text("Here is why …"), call("r1", "read")]);
		const next = assistant([call("q2")]);
		assert.equal(proseGateBlocks([...answered, prior, result("r1", "read"), next], next, "q2", "quiz"), false);
	});

	it("a learner's own message resets the walk; ask and the first question are never gated", () => {
		const next = assistant([call("q2")]);
		assert.equal(proseGateBlocks([...answered, { role: "user", content: "another one", timestamp: 2 }], next, "q2", "quiz"), false);
		assert.equal(proseGateBlocks(answered, next, "q2", "ask_user_question"), false);
		assert.equal(proseGateBlocks([{ role: "user", content: "hi", timestamp: 0 }], next, "q2", "quiz"), false);
	});

	it("a rejected quiz (an error result) is not an answer — the retry passes", () => {
		const next = assistant([call("q2")]);
		const rejected = { ...result("q1", "quiz"), isError: true };
		assert.equal(proseGateBlocks([{ role: "user", content: "quiz me", timestamp: 0 }, assistant([call("q1")]), rejected], next, "q2", "quiz"), false);
	});

	it("a probe-phase answer counts as a graded answer", () => {
		const next = assistant([call("q2")]);
		assert.equal(proseGateBlocks([assistant([call("p1", "probe")]), result("p1", "probe")], next, "q2", "quiz"), true);
	});
});

describe("the answer result carries the rule at the decision point", () => {
	const answer = { kind: "quiz", questionText: "Q", dontKnow: false, answers: [{ index: 1, label: "$4$" }], correct: true, confidence: 90, answeredAt: "2026-10-25T00:00:00Z" };
	const forModel = (toolName: string) => JSON.parse((newAnswerResult("q1", toolName, answer).content[0] as { text: string }).text);

	it("a gated teach answer (quiz / explain) carries `next`", () => {
		assert.equal(forModel("quiz").next, ANSWER_NEXT_TEXT);
		assert.equal(forModel("explain").next, ANSWER_NEXT_TEXT);
		assert.equal(forModel("quiz").correct, true, "the answer itself is unchanged");
	});

	it("probe, recall and ask answers do not", () => {
		for (const tool of ["probe", "recall", "ask_user_question"]) assert.equal(forModel(tool).next, undefined, tool);
	});
});

describe("the gate is live in the teacher (and only there)", () => {
	function engine(steps: Array<() => AssistantMessage>) {
		const faux = createFauxCore({});
		faux.setResponses(steps);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	}

	it("a bare quiz after an answer comes back refused; the retry with prose goes through", async () => {
		const agent = createTeacherAgent(undefined, {
			engine: engine([
				() => fauxAssistantMessage([fauxToolCall("quiz", quizArgs as ToolCall["arguments"], { id: "q2" })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([fauxText("Not quite — 2+2 is 4 because …"), fauxToolCall("quiz", quizArgs as ToolCall["arguments"], { id: "q3" })], { stopReason: "toolUse" }),
			]),
			tools: bareQuestionTools(),
			messages: answered as never,
		});
		await agent.continue();
		const results = agent.state.messages.filter((m) => (m as { role?: string }).role === "toolResult") as Array<{ toolCallId: string; isError: boolean; content: Array<{ text?: string }> }>;
		const refused = results.find((r) => r.toolCallId === "q2")!;
		assert.equal(refused.isError, true);
		assert.match(refused.content[0]!.text!, new RegExp(PROSE_GATE_REASON.slice(0, 40)));
		assert.equal(results.find((r) => r.toolCallId === "q3")!.isError, false, "the retry with prose is posed");
	});

	it("other agents are not gated (practice honors an injected registry)", async () => {
		const agent = createPracticeAgent({} as never, {
			engine: engine([() => fauxAssistantMessage([fauxToolCall("quiz", quizArgs as ToolCall["arguments"], { id: "q2" })], { stopReason: "toolUse" })]),
			tools: bareQuestionTools(),
			messages: answered as never,
		});
		await agent.continue();
		const r = agent.state.messages.find((m) => (m as { toolCallId?: string }).toolCallId === "q2") as { isError: boolean };
		assert.equal(r.isError, false);
	});
});
