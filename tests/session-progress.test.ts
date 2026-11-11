import assert from "node:assert/strict";
import { test } from "node:test";
import { learnProgress, sessionProgress, type PlanTree } from "../src/core/index.ts";

// a → (b | c) → d : three layers; b and c are parallel.
const tree: PlanTree = {
	version: 1,
	nodes: ["a", "b", "c", "d"].map((id) => ({ id, title: id })),
	edges: [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" }],
};
const at = (current: string | null, ...visited: string[]) => ({ current, visited: new Set(visited) });

test("learn: nothing tagged is 0, depth counts layers not boxes, finish is 1", () => {
	assert.equal(learnProgress(tree, at(null), false), 0);
	assert.equal(learnProgress(tree, at("a"), false), 1 / 3);
	assert.equal(learnProgress(tree, at("c", "a"), false), 2 / 3); // skipping b costs nothing
	assert.equal(learnProgress(tree, at("a", "c"), false), 2 / 3); // never moves backwards
	assert.equal(learnProgress(tree, at("d", "a"), true), 1);
	assert.equal(learnProgress(null, null, true), 1);
});

test("practice/placement: answered over expected, capped at 1", () => {
	const concluded = (id: string, outcome: string) => [
		{ role: "assistant", content: [{ type: "toolCall", id, name: "conclude", arguments: { outcome } }] },
		{ role: "toolResult", toolCallId: id, isError: false },
	];
	const messages = [...concluded("1", "solved"), ...concluded("2", "dismissed"), ...concluded("3", "taught")] as never;
	const input = { messages, skillCount: 4, tree: null, statuses: null, finished: false };
	assert.equal(sessionProgress("practice", input), 0.5);
	assert.equal(sessionProgress("practice", { ...input, skillCount: 1 }), 1);
	const answers = [1, 2].map((i) => ({ role: "toolResult", toolCallId: `q${i}`, isError: false, details: { kind: "quiz" } })) as never;
	assert.equal(sessionProgress("placement", { ...input, messages: answers, skillCount: 6 }), 1); // target 2
});
