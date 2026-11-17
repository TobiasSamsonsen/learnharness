/**
 * The verdict gate (owner, 2026-11-14 — the Diagonalisering lesson on the tablet): a wrong recall answer was read
 * correctly, then the tutor asked about AP=PD on another node with a long lead that repaired nothing. The pure rule,
 * including a replay of that history shape.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { verdictGateProblem, verdictGateReason } from "../src/core/verdict-gate.ts";

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
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
	type: "toolCall",
	id,
	name,
	arguments: args as ToolCall["arguments"],
});
const result = (toolCallId: string, toolName: string, body: Record<string, unknown>) => ({
	role: "toolResult" as const,
	toolCallId,
	toolName,
	content: [{ type: "text" as const, text: JSON.stringify(body) }],
	isError: false,
	timestamp: 1,
});
const user = { role: "user", content: "teach me", timestamp: 0 };

const recall = call("q1", "explain", { type: "recall", nodeId: "egen", skill: "sk_1", lead: "x", question: "q", correctAnswer: "a" });
const afterRecall = [user, assistant([recall]), result("q1", "explain", { kind: "explain", sketch: { id: "s" } })];
const quiz = call("q1", "quiz", { type: "check", nodeId: "n1", lead: "x", question: "q", correctAnswer: "a" });
const afterQuizMiss = [user, assistant([quiz]), result("q1", "quiz", { kind: "quiz", correct: false })];
const afterQuizHit = [user, assistant([quiz]), result("q1", "quiz", { kind: "quiz", correct: true })];

const next = (name: string, args: Record<string, unknown>) => assistant([call("q2", name, { lead: "y", question: "q", correctAnswer: "a", ...args })]);
const problem = (history: readonly unknown[], name: string, args: Record<string, unknown>) => {
	const m = next(name, args);
	return verdictGateProblem(history, m, name, (m.content[0] as ToolCall).arguments);
};

describe("previous: skipped (a text answer that is not an attempt)", () => {
	const afterText = [user, assistant([recall]), result("q1", "explain", { kind: "explain", text: "my drawing failed, wait for it" })];

	it("passes when the SAME question comes back on the same node and type", () => {
		assert.equal(problem(afterText, "explain", { type: "recall", nodeId: "egen", skill: "sk_1", previous: "skipped" }), null);
	});

	it("is refused when the next question moves to another node or type", () => {
		const moved = problem(afterText, "explain", { type: "recall", nodeId: "other", skill: "sk_1", previous: "skipped" });
		assert.deepEqual(moved, { kind: "skipped-moved", nodeId: "egen" });
		assert.match(verdictGateReason(moved!), /same question again/);
		assert.deepEqual(problem(afterText, "explain", { type: "check", nodeId: "egen", previous: "skipped" }), { kind: "skipped-moved", nodeId: "egen" });
	});

	it("lets a smaller final replace a final he called too big (same node and type, a different case)", () => {
		const final = call("q1", "explain", { type: "final", nodeId: "eksamen", lead: "x", question: "big", correctAnswer: "a" });
		const afterTooHard = [user, assistant([final]), result("q1", "explain", { kind: "explain", text: "too hard for a crash course" })];
		assert.equal(problem(afterTooHard, "explain", { type: "final", nodeId: "eksamen", question: "small", previous: "skipped" }), null);
		assert.deepEqual(problem(afterTooHard, "explain", { type: "final", nodeId: "other", question: "small", previous: "skipped" }), { kind: "skipped-moved", nodeId: "eksamen" });
		// graded wrong instead, the gate forces a repair check before any new final
		assert.deepEqual(problem(afterTooHard, "explain", { type: "final", nodeId: "eksamen", question: "small", previous: "wrong" }), { kind: "advanced", nodeId: "eksamen" });
	});

	it("cannot skip an answer that carries a recorded verdict", () => {
		assert.deepEqual(problem(afterQuizMiss, "quiz", { type: "check", nodeId: "n1", previous: "skipped" }), { kind: "skipped-graded" });
		assert.deepEqual(problem(afterQuizHit, "quiz", { type: "check", nodeId: "n1", previous: "skipped" }), { kind: "skipped-graded" });
	});
});

describe("verdictGateProblem", () => {
	it("replay: after a wrong recall, a predict on another node is refused", () => {
		const p = problem(afterRecall, "explain", { type: "predict", nodeId: "mppd", previous: "wrong" });
		assert.deepEqual(p, { kind: "advanced", nodeId: "egen" });
		assert.match(verdictGateReason(p!), /node `egen`/);
	});

	it("a check on the same node passes after a miss; so does a recall after a recall", () => {
		assert.equal(problem(afterRecall, "explain", { type: "check", nodeId: "egen", previous: "wrong" }), null);
		assert.equal(problem(afterRecall, "explain", { type: "recall", nodeId: "egen", skill: "sk_1", previous: "partly" }), null);
	});

	it("a miss refuses a predict on the same node, a final, and a recall that does not follow a recall", () => {
		assert.equal(problem(afterRecall, "explain", { type: "predict", nodeId: "egen", previous: "wrong" })?.kind, "advanced");
		assert.equal(problem(afterRecall, "explain", { type: "final", nodeId: "egen", previous: "partly" })?.kind, "advanced");
		assert.equal(problem(afterQuizMiss, "quiz", { type: "check", nodeId: "n2", previous: "wrong" })?.kind, "advanced");
		assert.equal(problem(afterQuizMiss, "explain", { type: "recall", nodeId: "n1", previous: "wrong" })?.kind, "advanced");
	});

	it("a right answer lets the tutor advance", () => {
		assert.equal(problem(afterRecall, "explain", { type: "predict", nodeId: "mppd", previous: "right" }), null);
		assert.equal(problem(afterQuizHit, "quiz", { type: "predict", nodeId: "n2", previous: "right" }), null);
	});

	it("a missing previous is refused once the learner has answered", () => {
		assert.deepEqual(problem(afterRecall, "explain", { type: "predict", nodeId: "mppd" }), { kind: "missing" });
		assert.deepEqual(problem(afterQuizHit, "quiz", { type: "check", nodeId: "n1", previous: "nonsense" }), { kind: "missing" });
	});

	it("a quiz answer recorded as wrong cannot be declared right", () => {
		assert.deepEqual(problem(afterQuizMiss, "quiz", { type: "check", nodeId: "n1", previous: "right" }), { kind: "contradiction" });
	});

	it("a don't-know counts as a miss", () => {
		const dk = [user, assistant([quiz]), result("q1", "quiz", { kind: "quiz", dontKnow: true })];
		assert.equal(problem(dk, "quiz", { type: "check", nodeId: "n1", previous: "right" })?.kind, "contradiction");
	});

	it("nothing to check: no graded answer yet, the learner spoke since, or an unguarded tool", () => {
		assert.equal(problem([user], "quiz", { type: "predict", nodeId: "n1" }), null);
		assert.equal(problem([...afterRecall, { role: "user", content: "wait", timestamp: 2 }], "explain", { type: "predict", nodeId: "mppd" }), null);
		assert.equal(problem(afterRecall, "ask_user_question", { nodeId: "mppd" }), null);
	});

	it("an answered ask_user_question since makes the older verdict stale", () => {
		const history = [...afterQuizMiss, assistant([call("a1", "ask_user_question", {})]), result("a1", "ask_user_question", { answer: "x" })];
		assert.equal(problem(history, "quiz", { type: "predict", nodeId: "n2", previous: "right" }), null);
	});

	it("refused calls and non-answer results are skipped when finding the last answer", () => {
		const refusedCall = { ...result("q9", "quiz", {}), isError: true };
		const history = [...afterRecall, assistant([call("q9", "quiz", {})]), refusedCall, result("r", "read_sketch", {})];
		assert.deepEqual(problem(history, "explain", { type: "predict", nodeId: "mppd", previous: "wrong" }), { kind: "advanced", nodeId: "egen" });
	});

	it("a previous question without a nodeId is not enforced", () => {
		const bare = call("q1", "explain", { type: "check", lead: "x" });
		const history = [user, assistant([bare]), result("q1", "explain", { kind: "explain" })];
		assert.equal(problem(history, "explain", { type: "predict", nodeId: "mppd", previous: "wrong" }), null);
	});
});
