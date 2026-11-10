/**
 * The lead floor (owner, 2026-11-10 — the ε-δ lesson on the tablet): after a
 * wrong or "don't know" answer the teacher's leads were 32, 39, 39 and 59
 * characters while the diagnosis sat in thinking; the ones that helped were 592
 * to 1580. The pure rule, then the live wiring through the teacher's
 * beforeToolCall.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { LEAD_FLOOR_CHARS, LEAD_FLOOR_REASON, LEAD_FLOOR_REASON_NO_LEAD, leadFloorBlocks, leadFloorReason } from "../src/core/lead-floor-gate.ts";
import { bareQuestionTools, createTeacherAgent, GATE_REFUSAL_CAP, makeGateRefusals } from "../src/agent/teacher-agent.ts";

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
const call = (id: string, name = "quiz", lead?: string): ToolCall => ({
	type: "toolCall",
	id,
	name,
	arguments: (lead === undefined ? quizArgs : { ...quizArgs, lead }) as ToolCall["arguments"],
});
const text = (t: string) => ({ type: "text" as const, text: t });
const sent = (id: string, message: string) => ({ type: "toolCall" as const, id, name: "send_to_user", arguments: { message } });
const answerResult = (toolCallId: string, toolName: string, verdict: Record<string, unknown>) => ({
	role: "toolResult" as const,
	toolCallId,
	toolName,
	content: [text(JSON.stringify({ kind: "quiz", ...verdict }))],
	isError: false,
	timestamp: 1,
});

/** A lead of exactly n characters (a real sentence, padded with words). */
const lead = (n: number): string => "Her er hva svaret ditt viser og hvorfor det ikke holder. ".repeat(10).slice(0, n);

const user = { role: "user", content: "teach me", timestamp: 0 };
const missed = [user, assistant([call("q1")]), answerResult("q1", "quiz", { correct: false })];
const dontKnow = [user, assistant([call("q1")]), answerResult("q1", "quiz", { dontKnow: true })];
const right = [user, assistant([call("q1")]), answerResult("q1", "quiz", { correct: true })];

describe("leadFloorBlocks (the pure rule)", () => {
	it("refuses a short lead after a wrong answer or a don't-know", () => {
		const next = assistant([call("q2", "quiz", lead(40))]);
		assert.equal(leadFloorBlocks(missed, next, "q2", "quiz"), true);
		assert.equal(leadFloorBlocks(dontKnow, next, "q2", "quiz"), true);
		assert.equal(leadFloorBlocks(missed, assistant([call("q2", "explain", lead(40))]), "q2", "explain"), true);
	});

	it("every free-recall (explain) answer needs the floor: it has no verdict the code can read", () => {
		const explainResult = (verdict: Record<string, unknown>) => [user, assistant([call("q1", "explain", lead(300))]), answerResult("q1", "explain", verdict)];
		const next = assistant([call("q2", "quiz", lead(40))]);
		assert.equal(leadFloorBlocks(explainResult({}), next, "q2", "quiz"), true);
		assert.equal(leadFloorBlocks(explainResult({ correct: true }), next, "q2", "quiz"), true);
		assert.equal(leadFloorBlocks(explainResult({}), assistant([call("q2", "quiz", lead(LEAD_FLOOR_CHARS))]), "q2", "quiz"), false);
	});

	it("the no-lead refusal has a plain-text fallback for a tutor without send_to_user", () => {
		assert.match(LEAD_FLOOR_REASON_NO_LEAD, /plain text before the call only if you have no send_to_user/);
	});

	it("the floor is exactly LEAD_FLOOR_CHARS", () => {
		assert.equal(LEAD_FLOOR_CHARS, 150);
		assert.equal(leadFloorBlocks(missed, assistant([call("q2", "quiz", lead(LEAD_FLOOR_CHARS - 1))]), "q2", "quiz"), true);
		assert.equal(leadFloorBlocks(missed, assistant([call("q2", "quiz", lead(LEAD_FLOOR_CHARS))]), "q2", "quiz"), false);
	});

	it("the real ε-δ leads: the fillers are refused, the useful one passes", () => {
		for (const filler of [
			"Legg 3 til hver side av $2<x<4$.",
			"Sjekk at du har retningen på ulikheten.",
			"Finn først hvilken side som har hoppet, og velg så $x$ der.",
		]) {
			assert.equal(leadFloorBlocks(missed, assistant([call("q2", "quiz", filler)]), "q2", "quiz"), true, filler);
		}
		const useful =
			"Du fant hoppet riktig: avstanden er 3, og det ligger til høyre for 2. Men du skrev $3<\\varepsilon$ som om det var en betingelse for at ting holder. " +
			"Ved diskontinuitet snur vi det: vi velger en $\\varepsilon$ som er **mindre enn eller lik** hoppet, for eksempel $\\varepsilon=1$.";
		assert.equal(leadFloorBlocks(missed, assistant([call("q2", "quiz", useful)]), "q2", "quiz"), false);
	});

	it("a correct answer keeps the plain presence rule: a short acknowledgement is fine", () => {
		assert.equal(leadFloorBlocks(right, assistant([call("q2", "quiz", "Riktig, neste steg.")]), "q2", "quiz"), false);
	});

	it("text before the call and a send_to_user message count toward the floor, with the lead", () => {
		assert.equal(leadFloorBlocks(missed, assistant([text(lead(160)), call("q2", "quiz", "Prøv igjen.")]), "q2", "quiz"), false, "a real explanation as text, then a short lead");
		assert.equal(leadFloorBlocks(missed, assistant([sent("s1", lead(160)), call("q2", "quiz", "Prøv igjen.")]), "q2", "quiz"), false, "or as a delivered message");
		assert.equal(leadFloorBlocks(missed, assistant([text(lead(100)), call("q2", "quiz", lead(60))]), "q2", "quiz"), false, "100 + 60 reaches the floor together");
		assert.equal(leadFloorBlocks(missed, assistant([text(lead(60)), call("q2", "quiz", lead(60))]), "q2", "quiz"), true, "60 + 60 does not");
	});

	it("prose in an earlier step of the same turn counts, but not past the next answer", () => {
		const prior = assistant([text(lead(200)), call("r1", "read")]);
		const readResult = { role: "toolResult" as const, toolCallId: "r1", toolName: "read", content: [text("file")], isError: false, timestamp: 1 };
		const next = assistant([call("q2", "quiz", "Prøv igjen.")]);
		assert.equal(leadFloorBlocks([...missed, prior, readResult, next], next, "q2", "quiz"), false);
		const second = [...missed, prior, readResult, assistant([call("q2")]), answerResult("q2", "quiz", { correct: false })];
		assert.equal(leadFloorBlocks(second, next, "q3", "quiz"), true, "his new miss starts a new walk");
	});

	it("a lead on a call that errored back was never shown: it does not count", () => {
		const refusedBefore = assistant([call("q2", "quiz", lead(300))]);
		const error = { role: "toolResult" as const, toolCallId: "q2", toolName: "quiz", content: [text("Refused")], isError: true, timestamp: 1 };
		const retry = assistant([call("q3", "quiz", lead(40))]);
		assert.equal(leadFloorBlocks([...missed, refusedBefore, error, retry], retry, "q3", "quiz"), true);
	});

	it("a sketch read in between does not hide the miss", () => {
		const read = assistant([{ type: "toolCall" as const, id: "rs1", name: "read_sketch", arguments: { sketchId: "sk_1", reading: "x", uncertain: [] } }]);
		const readResult = { role: "toolResult" as const, toolCallId: "rs1", toolName: "read_sketch", content: [text("Reading recorded.")], isError: false, timestamp: 1 };
		const short = assistant([call("q2", "quiz", lead(40))]);
		const long = assistant([call("q2", "quiz", lead(200))]);
		assert.equal(leadFloorBlocks([...missed, read, readResult, short], short, "q2", "quiz"), true);
		assert.equal(leadFloorBlocks([...missed, read, readResult, long], long, "q2", "quiz"), false);
	});

	it("the learner's own message resets the walk; the first question is never gated", () => {
		const next = assistant([call("q2", "quiz", lead(40))]);
		assert.equal(leadFloorBlocks([...missed, { role: "user", content: "jeg forstår ikke", timestamp: 2 }], next, "q2", "quiz"), false);
		assert.equal(leadFloorBlocks([user], next, "q2", "quiz"), false);
	});

	it("an ask_user_question after a miss is gated too (its reply rides in send_to_user); other tools are not", () => {
		const ask = { type: "toolCall" as const, id: "a1", name: "ask_user_question", arguments: { question: "Hva nå?", options: [{ label: "a" }, { label: "b" }] } };
		assert.equal(leadFloorBlocks(missed, assistant([sent("s1", lead(40)), ask]), "a1", "ask_user_question"), true);
		assert.equal(leadFloorBlocks(missed, assistant([sent("s1", lead(200)), ask]), "a1", "ask_user_question"), false);
		assert.equal(leadFloorBlocks(missed, assistant([call("p1", "probe", lead(10))]), "p1", "probe"), false, "probe is not a teach question");
		assert.equal(leadFloorBlocks(missed, assistant([call("p1", "read_sketch")]), "p1", "read_sketch"), false);
	});

	it("reads the miss from the full record when the compact content is not JSON", () => {
		const plain = { ...answerResult("q1", "quiz", {}), content: [text("The learner answered.")], details: { correct: false } };
		const next = assistant([call("q2", "quiz", lead(40))]);
		assert.equal(leadFloorBlocks([user, assistant([call("q1")]), plain as never], next, "q2", "quiz"), true);
	});

	it("each refusal names the right channel for its tool", () => {
		assert.equal(leadFloorReason("quiz"), LEAD_FLOOR_REASON);
		assert.equal(leadFloorReason("explain"), LEAD_FLOOR_REASON);
		assert.equal(leadFloorReason("ask_user_question"), LEAD_FLOOR_REASON_NO_LEAD);
		assert.match(LEAD_FLOOR_REASON, /`lead`/);
		assert.match(LEAD_FLOOR_REASON_NO_LEAD, /send_to_user/);
		assert.doesNotMatch(LEAD_FLOOR_REASON_NO_LEAD, /`lead`/);
		assert.match(LEAD_FLOOR_REASON, new RegExp(String(LEAD_FLOOR_CHARS)));
	});
});

describe("the floor is live in the teacher", () => {
	function engine(steps: Array<() => AssistantMessage>) {
		const faux = createFauxCore({});
		faux.setResponses(steps);
		return { model: { ...faux.getModel(), provider: "claude-code" }, streamFn: faux.streamSimple };
	}
	type ToolResultLike = { toolCallId: string; isError: boolean; content: Array<{ text?: string }> };

	it("a filler lead after a miss comes back refused; the retry with a real explanation is posed", async () => {
		const filler = { ...quizArgs, lead: "Legg 3 til hver side av $2<x<4$." };
		const real = { ...quizArgs, lead: lead(200) };
		const agent = createTeacherAgent(undefined, {
			engine: engine([
				() => fauxAssistantMessage([fauxToolCall("quiz", filler as ToolCall["arguments"], { id: "q2" })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([fauxToolCall("quiz", real as ToolCall["arguments"], { id: "q3" })], { stopReason: "toolUse" }),
			]),
			tools: bareQuestionTools(),
			messages: missed as never,
		});
		await agent.continue();
		const results = agent.state.messages.filter((m) => (m as { role?: string }).role === "toolResult") as ToolResultLike[];
		const refused = results.find((r) => r.toolCallId === "q2")!;
		assert.equal(refused.isError, true);
		assert.equal(refused.content[0]!.text, LEAD_FLOOR_REASON);
		assert.equal(results.find((r) => r.toolCallId === "q3")!.isError, false, "the retry with a real explanation is posed");
	});

	it("after a correct answer the same short lead is posed", async () => {
		const short = { ...quizArgs, lead: "Riktig, neste steg." };
		const agent = createTeacherAgent(undefined, {
			engine: engine([() => fauxAssistantMessage([fauxToolCall("quiz", short as ToolCall["arguments"], { id: "q2" })], { stopReason: "toolUse" })]),
			tools: bareQuestionTools(),
			messages: right as never,
		});
		await agent.continue();
		const results = agent.state.messages.filter((m) => (m as { role?: string }).role === "toolResult") as ToolResultLike[];
		assert.equal(results.find((r) => r.toolCallId === "q2")!.isError, false);
	});
});

describe("the refusal cap", () => {
	it("a gate refuses GATE_REFUSAL_CAP times in a run, then lets the call through; each gate counts alone", () => {
		const refuse = makeGateRefusals();
		for (let i = 0; i < GATE_REFUSAL_CAP; i++) assert.deepEqual(refuse("lead-floor", true, "r"), { block: true, reason: "r" });
		assert.equal(refuse("lead-floor", true, "r"), undefined);
		assert.deepEqual(refuse("visual", true, "v"), { block: true, reason: "v" }, "another gate is unaffected");
		assert.equal(refuse("prose", false, "p"), undefined, "a gate that does not block is not counted");
	});
});
