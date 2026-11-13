/**
 * HINTS IN LESSONS (owner, 2026-11-13 — core/hints.ts): which questions offer
 * the Hint button, the instruction texts, how hints ride an answer to the
 * tutor, and the hint route's refusals (the model call itself is the
 * clarification call's, covered by its own tests).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-hints-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { HINT_MAX, HINT_TEXT_MAX, hintEligible, hintPrompt, hintsNextText, hintsOf } = await import("../src/core/hints.ts");
const { buildAnswer, compactAnswerForModel } = await import("../src/core/question-core.ts");
const { newAnswerResult } = await import("../src/core/native-messages.ts");
const { handleHintRequest } = await import("../src/server/hint.ts");
const { chatStore } = await import("../src/store/chats.ts");

import type { QuestionData } from "../src/core/question-core.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("which questions offer a hint", () => {
	it("lesson checks do, multiple choice and free-form; predictions, the final problem, the probe and asks do not", () => {
		assert.equal(hintEligible("quiz", { type: "check" }, "teach"), true);
		assert.equal(hintEligible("explain", { type: "check" }, "teach"), true);
		assert.equal(hintEligible("quiz", {}, "teach"), true, "an old record with no type is a check");
		assert.equal(hintEligible("quiz", { type: "predict" }, "teach"), false);
		assert.equal(hintEligible("explain", { type: "final" }, "teach"), false);
		assert.equal(hintEligible("quiz", { type: "check" }, "probe"), false);
		assert.equal(hintEligible("probe", {}, "teach"), false);
		assert.equal(hintEligible("ask_user_question", {}, "teach"), false);
	});
});

describe("the instruction texts", () => {
	it("the hint call is told which hint, the three levels, the bans, the earlier hints and the learner's thinking", () => {
		const text = hintPrompt({ n: 2, earlier: ["Look at the roots."], thinking: "I tried A e^{-2x}" });
		assert.match(text, /^\[HINT REQUEST — NOT AN ANSWER\]/);
		assert.match(text, /hint 2 of 3/);
		assert.match(text, /1: where to look/);
		assert.match(text, /2: the idea, rule or definition that applies, named/);
		assert.match(text, /3: the move outlined in words/);
		assert.match(text, /Never a worked step, a number or expression from the answer, or which option is right or wrong/);
		assert.match(text, /Hints already given on this question:\n1: Look at the roots\./);
		assert.match(text, /What the learner has written so far.*I tried A e\^\{-2x\}/);
		const first = hintPrompt({ n: 1, earlier: [] });
		assert.ok(!first.includes("Hints already given"));
		assert.ok(!first.includes("has written so far"));
	});

	it("the tutor is told the answer was aided and to check the step again", () => {
		assert.match(hintsNextText(1), /^He took 1 hint on this question/);
		assert.match(hintsNextText(2), /^He took 2 hints on this question \(in `hints`\), so the answer is not unaided\./);
		assert.match(hintsNextText(2), /check it once more on a fresh case, without hints\.$/);
	});

	it("hints are sanitized: strings only, trimmed, capped in length and number", () => {
		assert.deepEqual(hintsOf(["a", " b ", 3, "", "c", "d"]), ["a", "b", "c"]);
		assert.equal(hintsOf(["x".repeat(HINT_TEXT_MAX + 50)])[0]!.length, HINT_TEXT_MAX);
		assert.deepEqual(hintsOf("nope"), []);
		assert.equal(HINT_MAX, 3);
	});
});

describe("hints ride the answer", () => {
	const qd: QuestionData = {
		id: "q1", kind: "quiz", questionType: "check", question: "Q?", mode: "single-select",
		options: [{ label: "A", value: "a", index: 1 }, { label: "B", value: "b", index: 2 }] as never, correctIndices: [1], explanation: "because", createdAt: "t",
	};

	it("the record keeps them, the model sees them, and `next` says the answer was aided", () => {
		const answer = buildAnswer(qd, { values: ["a"], confidence: 90, hints: ["Look at the roots.", "It is resonance."] }, "quiz");
		assert.deepEqual(answer.hints, ["Look at the roots.", "It is resonance."]);
		assert.deepEqual(compactAnswerForModel(answer).hints, ["Look at the roots.", "It is resonance."]);
		const result = newAnswerResult("q1", "quiz", answer);
		const forModel = JSON.parse((result.content[0] as { text: string }).text) as { next: string; hints: string[] };
		assert.match(forModel.next, /Reply in the next question's `lead`/);
		assert.ok(forModel.next.endsWith(hintsNextText(2)));
	});

	it("an answer without hints is unchanged", () => {
		const answer = buildAnswer(qd, { values: ["a"], confidence: 90 }, "quiz");
		assert.equal("hints" in answer, false);
		const forModel = JSON.parse((newAnswerResult("q1", "quiz", answer).content[0] as { text: string }).text) as { next: string; hints?: unknown };
		assert.equal(forModel.hints, undefined);
		assert.ok(!forModel.next.includes("hint"));
	});
});

describe("the hint route's refusals", () => {
	const call = async (chatId: string, body: unknown) => handleHintRequest(chatId, body);

	it("needs a call id, an existing chat, fewer than three earlier hints, and that question open", async () => {
		assert.equal((await call("chat_nope", {})).status, 400);
		assert.equal((await call("chat_nope", { toolCallId: "q1", earlier: [] })).status, 404);
		const chat = chatStore.createChat("Lesson");
		assert.equal((await call(chat.id, { toolCallId: "q1", earlier: ["a", "b", "c"] })).status, 400);
	});
});

// ─── the hint call, against a scripted model ────────────────────────────────

const { createFauxCore, fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
import type { PiEngine } from "../src/agent/models.ts";

function scripted(replies: string[]): { engine: PiEngine; contexts: any[] } {
	const contexts: any[] = [];
	const faux = createFauxCore({});
	faux.setResponses(replies.map((text) => (ctx: unknown) => (contexts.push(ctx), fauxAssistantMessage([fauxText(text)]))) as never);
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, contexts };
}

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const STAMP = { stopReason: "toolUse", api: "openai-completions", provider: "openrouter", model: "z-ai/glm-5.3-flash", usage: USAGE };

/** A lesson in its teach phase whose history ends in an open question of the given type. */
function lessonWithOpen(type: string, tool = "quiz") {
	const chat = chatStore.createChat("Lesson");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(chat.id, [
		{ id: "m_user", role: "user", content: "teach me resonance", timestamp: 1 } as never,
		{ id: "m_probe", role: "assistant", timestamp: 2, ...STAMP, content: [{ type: "toolCall", id: "pd", name: "probe_done", arguments: { assessment: "knows the homogeneous case" } }] } as never,
		{ id: "m_probe_r", role: "toolResult", toolCallId: "pd", toolName: "probe_done", content: [{ type: "text", text: "ok" }], details: { ok: true }, isError: false, timestamp: 3 } as never,
		{
			id: "m_asst", role: "assistant", timestamp: 4, ...STAMP,
			content: [{ type: "toolCall", id: "call-1", name: tool, arguments: { type, nodeId: "n", lead: "Now try it.", question: "Find a particular solution.", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "because" } }],
		} as never,
	]);
	return chat;
}

describe("the hint call", () => {
	it("gives one hint on the open check, sends the model the rung and the learner's thinking, and writes nothing to the transcript", async () => {
		const chat = lessonWithOpen("check");
		const before = chatStore.getChat(chat.id)!.messages.length;
		const { engine, contexts } = scripted(["Look at the roots first."]);
		const res = await handleHintRequest(chat.id, { toolCallId: "call-1", earlier: [], thinking: "I tried A e^{-2x}" }, engine);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { hint: "Look at the roots first.", n: 1 });
		const sent = JSON.stringify(contexts[0]);
		assert.match(sent, /HINT REQUEST/);
		assert.match(sent, /hint 1 of 3/);
		assert.match(sent, /I tried A e\^\{-2x\}/);
		assert.equal(chatStore.getChat(chat.id)!.messages.length, before, "the question stays open, nothing appended");
	});

	it("the second hint is told the first", async () => {
		const chat = lessonWithOpen("check", "explain");
		const { engine, contexts } = scripted(["It is resonance."]);
		const res = await handleHintRequest(chat.id, { toolCallId: "call-1", earlier: ["Look at the roots first."] }, engine);
		assert.deepEqual(await res.json(), { hint: "It is resonance.", n: 2 });
		const sent = JSON.stringify(contexts[0]);
		assert.ok(sent.includes("Hints already given on this question:") && sent.includes("1: Look at the roots first."));
	});

	it("refuses a prediction, the final problem, another question's id, and a running turn", async () => {
		const { engine } = scripted([]);
		assert.equal((await handleHintRequest(lessonWithOpen("predict").id, { toolCallId: "call-1", earlier: [] }, engine)).status, 400);
		assert.equal((await handleHintRequest(lessonWithOpen("final", "explain").id, { toolCallId: "call-1", earlier: [] }, engine)).status, 400);
		const chat = lessonWithOpen("check");
		assert.equal((await handleHintRequest(chat.id, { toolCallId: "other", earlier: [] }, engine)).status, 409);
		assert.ok(beginTurn(chat.id));
		assert.equal((await handleHintRequest(chat.id, { toolCallId: "call-1", earlier: [] }, engine)).status, 409);
		endTurn(chat.id);
	});
});
