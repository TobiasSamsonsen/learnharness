/**
 * M11 Q2 (docs/android/m11-plan.md): a fresh `claude` process replays the whole transcript; practice problems
 * that were concluded before a later problem was posed are left out of that replay (one omitted-note each).
 * The active problem always stays in full. The replay is the only thing shortened.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { elidedProblems, renderClaudeCodeRequest } from "../src/agent/claude-code.ts";
import { normalizeContext } from "@earendil-works/pi-ai";

type Msg = Record<string, unknown>;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string, t: number): Msg => ({ role: "user", content: text, timestamp: t });
const assistant = (blocks: Msg[], t: number): Msg => ({ role: "assistant", content: blocks, api: "x", provider: "x", model: "x", usage, stopReason: "toolUse", timestamp: t });
const call = (id: string, name: string, args: Record<string, unknown>): Msg => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, name: string, text: string, isError = false, t = 0): Msg => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: t });

const pose = (n: number): Msg[] => [
	assistant([call(`p${n}`, "problem", { statement: `Problem ${n}: find the area of triangle ${n}.` })], n * 10),
	result(`p${n}`, "problem", "Problem posed", false, n * 10 + 1),
	user(`thinking about problem ${n} SECRET-THINKING-${n}`, n * 10 + 2),
];
const conclude = (n: number, outcome: string, isError = false): Msg[] => [
	assistant([call(`c${n}`, "conclude", { outcome })], n * 10 + 3),
	result(`c${n}`, "conclude", isError ? "refused: a sketch is unread" : "Concluded", isError, n * 10 + 4),
];

const render = (messages: Msg[]) => {
	const request = renderClaudeCodeRequest(normalizeContext({ systemPrompt: "tutor", tools: [], messages: messages as never }));
	return request.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("");
};
const asMessages = (messages: Msg[]) => messages as never;

test("a problem concluded before a later pose is replaced by one omitted-note", () => {
	const messages = [user("start", 1), ...pose(1), ...conclude(1, "solved"), assistant([{ type: "text", text: "Nice." }], 50), ...pose(2)];
	const spans = elidedProblems(asMessages(messages));
	assert.equal(spans.length, 1);
	assert.equal(spans[0]!.outcome, "solved");
	assert.equal(spans[0]!.from, 1);
	assert.equal(spans[0]!.to, 5, "through the conclude result");
	const text = render(messages);
	assert.match(text, /<omitted>An earlier practice problem \(Problem 1: find the area of triangle 1\.\) was concluded as solved/);
	assert.doesNotMatch(text, /SECRET-THINKING-1/, "the elided problem's thinking is not replayed");
	assert.match(text, /Nice\./, "what followed the conclude stays");
	assert.match(text, /SECRET-THINKING-2/, "the active problem stays in full");
	assert.match(text, /Problem 2: find the area/);
});

test("the active problem is never elided, even when it was concluded", () => {
	const messages = [user("start", 1), ...pose(1), ...conclude(1, "solved")];
	assert.deepEqual(elidedProblems(asMessages(messages)), []);
	assert.match(render(messages), /SECRET-THINKING-1/);
});

test("a problem with no successful conclude before the next pose is kept", () => {
	const refused = [...pose(1), ...conclude(1, "solved", true), ...pose(2)];
	assert.deepEqual(elidedProblems(asMessages(refused)), [], "a refused conclude closes nothing");
	const never = [...pose(1), ...pose(2)];
	assert.deepEqual(elidedProblems(asMessages(never)), []);
	assert.match(render(refused), /SECRET-THINKING-1/);
});

test("several concluded problems each get a note; the last one stays", () => {
	const messages = [...pose(1), ...conclude(1, "solved"), ...pose(2), ...conclude(2, "movedOn"), ...pose(3)];
	const spans = elidedProblems(asMessages(messages));
	assert.deepEqual(spans.map((s) => s.outcome), ["solved", "movedOn"]);
	const text = render(messages);
	assert.equal(text.match(/<omitted>/g)?.length, 2);
	assert.doesNotMatch(text, /SECRET-THINKING-[12]\b/);
	assert.match(text, /SECRET-THINKING-3/);
});

test("a long statement is cut in the note, and a transcript without problems is untouched", () => {
	const long = "x".repeat(300);
	const messages = [assistant([call("pa", "problem", { statement: long })], 1), result("pa", "problem", "ok", false, 2), ...conclude(9, "surrendered"), ...pose(2)];
	assert.match(render(messages), /<omitted>An earlier practice problem \(x{120}…\)/);
	const plain = [user("hi", 1), assistant([{ type: "text", text: "hello" }], 2)];
	assert.deepEqual(elidedProblems(asMessages(plain)), []);
	assert.doesNotMatch(render(plain), /<omitted>/);
});
