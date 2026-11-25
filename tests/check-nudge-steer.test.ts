/**
 * End a teaching turn with a check, and the Steer button's answer (owner, 2026-11-18, the Taylor lesson on the tablet):
 * a text-only stop after a teach answer gets one hidden reminder; a steer is a dismissal that wakes the tutor, is never
 * graded, and may change the plan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { CHECK_NUDGE_TEXT, needsCheckNudge } from "../src/core/check-nudge.ts";
import { STEER_NEXT_TEXT } from "../src/core/answer-rules.ts";
import { compactAnswerForModel, dismissedAnswer, steeredAnswer } from "../src/core/question-core.ts";
import { endsInDismissal, isSideQuestionMarker, newAnswerResult, newCheckNudgeMarker, type LhMessage } from "../src/core/native-messages.ts";
import { leadFloorBlocks } from "../src/core/lead-floor-gate.ts";
import { verdictGateProblem } from "../src/core/verdict-gate.ts";
import { bareQuestionTools, createTeacherAgent } from "../src/agent/teacher-agent.ts";

const quizArgs = {
	type: "check", nodeId: "n1", previous: "right", question: "What is $2+2$?", explanation: "$2+2=4$.",
	options: [{ label: "$4$", value: "a" }, { label: "$5$", value: "b" }], correctAnswer: "a",
};
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage => ({
	role: "assistant", content, api: "faux", provider: "faux", model: "faux",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason, timestamp: 1,
});
const call = (id: string, name = "quiz", args: Record<string, unknown> = quizArgs): ToolCall => ({ type: "toolCall", id, name, arguments: args as ToolCall["arguments"] });
const text = (t: string) => ({ type: "text" as const, text: t });
const result = (toolCallId: string, toolName: string, body = '{"kind":"quiz","correct":true}') => ({
	role: "toolResult" as const, toolCallId, toolName, content: [text(body)], isError: false, timestamp: 1,
});
const user = (t: string) => ({ role: "user", content: t, timestamp: 0 });
const answered = [user("teach me"), assistant([text("Step one."), call("q1")]), result("q1", "quiz")];
const stop = (t: string) => assistant([text(t)], "stop");

describe("needsCheckNudge (the pure rule)", () => {
	it("a text-only stop that replies to a teach answer needs it", () => {
		const reply = stop("Here is the next step, in words only.");
		assert.equal(needsCheckNudge([...answered, reply], reply), true);
		// a tool the tutor ran in between does not hide the answer
		const read = assistant([call("r1", "read_sketch", { sketchId: "sk_x" })]);
		assert.equal(needsCheckNudge([...answered, read, result("r1", "read_sketch", "Reading recorded."), reply], reply), true);
	});

	it("not the plan-presentation turn, not after the learner spoke, not a probe, not with a call, not the final problem", () => {
		const reply = stop("The plan is above; tell me when to start.");
		assert.equal(needsCheckNudge([user("hi"), assistant([call("p1", "plan_init", {})]), result("p1", "plan_init", "{}"), reply], reply), false);
		assert.equal(needsCheckNudge([...answered, user("wait"), reply], reply), false, "the learner's own message");
		assert.equal(needsCheckNudge([user("hi"), assistant([call("a1", "ask_user_question", {})]), result("a1", "ask_user_question", "{}"), reply], reply), false);
		assert.equal(needsCheckNudge([...answered, assistant([text("x"), call("q2")], "toolUse")], assistant([text("x"), call("q2")], "toolUse")), false);
		const final = [user("go"), assistant([call("f1", "explain", { ...quizArgs, type: "final" })]), result("f1", "explain", '{"kind":"explain"}')];
		assert.equal(needsCheckNudge([...final, reply], reply), false, "a lesson may end in text after its final problem");
		assert.equal(needsCheckNudge([...answered, assistant([text("")], "stop")], assistant([text("")], "stop")), false, "no text, nothing to remind about");
	});

	it("a learner's sketch dispute in between does not hide the unanswered teach answer (the Superposisjon lesson, 2026-11-25)", () => {
		const reply = stop("Riktig. Parallell og serie sitter.");
		const dispute = { role: "custom", customType: "sketch-dispute", content: "[The learner says your reading is wrong.]", display: true, timestamp: 1 };
		const read = assistant([call("r1", "read_sketch", { sketchId: "sk_x" })]);
		const history = [...answered, read, result("r1", "read_sketch", "Reading recorded, with doubts."), dispute, read, result("r1", "read_sketch", "Reading recorded."), reply];
		assert.equal(needsCheckNudge(history, reply), true);
		assert.equal(needsCheckNudge([...answered, { role: "custom", customType: "side-question", content: "q", display: false, timestamp: 1 }, reply], reply), false, "other custom messages still end the walk");
	});
});

describe("the reminder is live in the teacher: once per run, hidden, and only mid-plan", () => {
	function run(responses: Array<() => AssistantMessage>, messages: unknown[] = answered) {
		const faux = createFauxCore({});
		faux.setResponses(responses);
		const requests: string[] = [];
		const agent = createTeacherAgent(undefined, {
			engine: {
				model: faux.getModel(),
				streamFn: (m, context, options) => {
					requests.push(JSON.stringify(context.messages.at(-1)));
					assert.ok(getCurrentTools(context.messages).some((t) => t.name === "quiz"));
					return faux.streamSimple(m, context, options);
				},
			},
			tools: bareQuestionTools(),
			messages: messages as never,
		});
		return { agent, requests };
	}

	it("a text-only reply gets the reminder as a hidden marker, and the check that follows is posed", async () => {
		const { agent, requests } = run([
			() => fauxAssistantMessage([fauxText("Here is the next step, in words only.")], { stopReason: "stop" }),
			() => fauxAssistantMessage([fauxToolCall("quiz", { ...quizArgs, lead: "Now a check on that step." } as ToolCall["arguments"], { id: "q2" })], { stopReason: "toolUse" }),
		]);
		await agent.continue();
		assert.equal(requests.length, 2, "the run continued at its own stop");
		assert.ok(requests[1]!.includes("REMINDER"), "the second request ends with the reminder");
		const marker = agent.state.messages.find((m) => (m as { customType?: string }).customType === "check-nudge") as LhMessage | undefined;
		assert.ok(marker, "it is kept in the record as a marker the transcript hides");
		assert.equal((marker as { content: string }).content, CHECK_NUDGE_TEXT);
		assert.ok(agent.state.messages.some((m) => (m as { toolCallId?: string }).toolCallId === "q2"), "the quiz is posed");
	});

	it("a second text-only stop ends the run: it never loops", async () => {
		const { agent, requests } = run([
			() => fauxAssistantMessage([fauxText("One.")], { stopReason: "stop" }),
			() => fauxAssistantMessage([fauxText("Two.")], { stopReason: "stop" }),
			() => fauxAssistantMessage([fauxText("Three, must never be asked for.")], { stopReason: "stop" }),
		]);
		await agent.continue();
		assert.equal(requests.length, 2);
	});

	it("a turn that starts from the learner's own message is left alone", async () => {
		const { agent, requests } = run(
			[() => fauxAssistantMessage([fauxText("Sure, here it is.")], { stopReason: "stop" })],
			[...answered, user("can you explain that again?")],
		);
		await agent.continue();
		assert.equal(requests.length, 1);
	});
});

describe("a steer: the question set aside, the tutor woken, nothing graded", () => {
	const steer = steeredAnswer("explain", "Q?", "Use my lecture's notation, please.", ["Look at the exponents."]);

	it("is a dismissal that carries his words and the hints taken", () => {
		assert.equal(steer.dismissed, true);
		assert.deepEqual(compactAnswerForModel(steer), { kind: "explain", dismissed: true, steer: "Use my lecture's notation, please.", hints: ["Look at the exponents."] });
		assert.deepEqual(compactAnswerForModel(dismissedAnswer("explain", "Q?")), { kind: "explain", dismissed: true }, "a plain dismissal is unchanged");
	});

	it("the result tells the tutor it is not an answer, and not to treat the hints as aid", () => {
		const forModel = JSON.parse((newAnswerResult("e1", "explain", steer).content[0] as { text: string }).text);
		assert.equal(forModel.next, STEER_NEXT_TEXT);
		assert.match(forModel.next, /NOT an answer/);
		assert.ok(!/not unaided/.test(forModel.next));
	});

	it("never pauses the session (a plain dismissal does), so the tutor answers at once", () => {
		const steered = newAnswerResult("e1", "explain", steer);
		const dismissed = newAnswerResult("e1", "explain", dismissedAnswer("explain", "Q?"));
		assert.equal(endsInDismissal([steered as never]), false);
		assert.equal(endsInDismissal([dismissed as never]), true);
	});

	it("is exempt from the lead floor, and the next question may move the plan on", () => {
		const q = assistant([call("e1", "explain", { ...quizArgs, nodeId: "n1" })]);
		const steered = newAnswerResult("e1", "explain", steer);
		const next = assistant([call("e2", "explain", { ...quizArgs, nodeId: "n2", previous: "skipped", lead: "Short." })]);
		assert.equal(leadFloorBlocks([user("go"), q, steered, next], next, "e2", "explain"), false, "a one-line lead after a steer is not refused");
		assert.equal(verdictGateProblem([user("go"), q, steered], next, "explain", { nodeId: "n2", type: "check", previous: "skipped" }), null, "a steer may move the plan");
		// a plain skip still has to come back to the same step
		const dismissed = newAnswerResult("e1", "explain", dismissedAnswer("explain", "Q?"));
		assert.equal(verdictGateProblem([user("go"), q, dismissed], next, "explain", { nodeId: "n2", type: "check", previous: "skipped" })?.kind, "skipped-moved");
	});

	it("the hidden marker is a side entry: it leaves the tail's meaning alone", () => {
		assert.equal(isSideQuestionMarker(newCheckNudgeMarker()), true);
	});
});
