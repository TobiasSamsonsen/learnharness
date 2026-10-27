/**
 * The prose gate (owner, 2026-10-25 — the ITGK lesson: twenty teacher
 * turns went thinking → next quiz, the learner never saw a word of
 * teaching). The pure rule, then the live wiring through the teacher's
 * beforeToolCall.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { ANSWER_NEXT_TEXT, PROSE_GATE_REASON, proseGateBlocks, proseGateRefusedLast } from "../src/core/prose-gate.ts";
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

describe("proseGateRefusedLast (what the force-text step keys on)", () => {
	const refusal = { ...result("q2", "quiz"), isError: true, content: [text(PROSE_GATE_REASON)] };

	it("true when the tail of the transcript is this gate's refusal", () => {
		assert.equal(proseGateRefusedLast([...answered, assistant([call("q2")]), refusal]), true);
	});

	it("false for a graded answer, another error, or once anything else follows", () => {
		assert.equal(proseGateRefusedLast(answered), false);
		const other = { ...refusal, content: [text("Refused: the question is malformed")] };
		assert.equal(proseGateRefusedLast([...answered, assistant([call("q2")]), other]), false);
		assert.equal(proseGateRefusedLast([...answered, assistant([call("q2")]), refusal, assistant([text("Here is why …")])]), false);
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
	function engine(steps: Array<() => AssistantMessage>, provider?: string) {
		const faux = createFauxCore({});
		faux.setResponses(steps);
		return { model: provider ? { ...faux.getModel(), provider } : faux.getModel(), streamFn: faux.streamSimple };
	}

	// On Claude Code force-text is off, so the retry is the model's own: prose and the question in one message.
	it("a bare quiz after an answer comes back refused; the retry with prose goes through", async () => {
		const agent = createTeacherAgent(undefined, {
			engine: engine([
				() => fauxAssistantMessage([fauxToolCall("quiz", quizArgs as ToolCall["arguments"], { id: "q2" })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([fauxText("Not quite — 2+2 is 4 because …"), fauxToolCall("quiz", quizArgs as ToolCall["arguments"], { id: "q3" })], { stopReason: "toolUse" }),
			], "claude-code"),
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

	/** Three scripted replies: a bare quiz (refused), a text-only reply, a quiz. Records which tools each request declared. */
	async function forcedRun(provider?: string) {
		const faux = createFauxCore({});
		faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall("quiz", quizArgs as ToolCall["arguments"], { id: "q2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Not quite — 2+2 is 4 because …")], { stopReason: "stop" }),
			() => fauxAssistantMessage([fauxToolCall("quiz", quizArgs as ToolCall["arguments"], { id: "q3" })], { stopReason: "toolUse" }),
		]);
		const declared: string[][] = [];
		const model = provider ? { ...faux.getModel(), provider } : faux.getModel();
		const agent = createTeacherAgent(undefined, {
			engine: {
				model,
				streamFn: (m, context, options) => {
					declared.push(getCurrentTools(context.messages).map((t) => t.name));
					return faux.streamSimple(m, context, options);
				},
			},
			tools: bareQuestionTools(),
			messages: answered as never,
		});
		await agent.continue();
		return { declared, results: agent.state.messages.filter((m) => (m as { role?: string }).role === "toolResult") as Array<{ toolCallId: string; isError: boolean }> };
	}

	it("force-text: after a refusal the next request has no question tools, and the one after it has them back", async () => {
		const { declared, results } = await forcedRun();
		assert.equal(declared.length, 3, "refused call, text-only reply, then the quiz");
		assert.ok(declared[0]!.includes("quiz"), "the first request declares quiz");
		assert.ok(!declared[1]!.includes("quiz") && !declared[1]!.includes("explain"), "the request after the refusal is text-only");
		assert.ok(declared[2]!.includes("quiz"), "the tools are back for the request after the text");
		assert.equal(results.find((r) => r.toolCallId === "q3")!.isError, false, "the quiz is posed after the text");
	});

	it("force-text is off on Claude Code (a tool change would respawn the session)", async () => {
		const { declared, results } = await forcedRun("claude-code");
		assert.ok(declared.every((names) => names.includes("quiz")), "quiz stays declared on every request");
		assert.equal(results.find((r) => r.toolCallId === "q2")!.isError, true, "still refused by the gate");
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
