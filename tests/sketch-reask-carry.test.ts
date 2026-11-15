/**
 * A re-ask on the same node keeps the learner's unsent page: the new call has a new id, and ink lives under the id.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
	key: (i: number) => [...store.keys()][i] ?? null,
	get length() {
		return store.size;
	},
} as Storage;

const { writeInk, readInk, flushInk, forgetInkMemory, inkFromStrokes } = await import("../components/sketch/ink-memory.ts");
const { carryInkToReask, previousCallOnNode } = await import("../components/sketch/reask-carry.ts");

const stroke = (n: number) => ({ size: 4, points: [n, n, 0.5, n + 10, n + 10, 0.5] });
const call = (id: string, nodeId: string, state = "output-available") => ({ type: "tool-explain", toolCallId: id, input: { nodeId }, state });
const msgs = (...parts: ReturnType<typeof call>[]) => [{ parts }];

describe("a re-ask on the same node", () => {
	beforeEach(() => {
		flushInk();
		store.clear();
		forgetInkMemory();
	});

	it("finds the newest earlier call on the node, never a later one or another node", () => {
		const m = msgs(call("a", "n1"), call("b", "n2"), call("c", "n1"), call("d", "n1", "input-available"), call("e", "n1"));
		assert.equal(previousCallOnNode(m, "d", "n1"), "c");
		assert.equal(previousCallOnNode(m, "b", "n2"), null);
		assert.equal(previousCallOnNode(m, "a", "n1"), null);
	});

	it("moves the unsent page to the new call", () => {
		writeInk("old", inkFromStrokes([stroke(1), stroke(2)]));
		assert.equal(carryInkToReask(msgs(call("old", "n1"), call("new", "n1", "input-available")), "new", { nodeId: "n1" }), true);
		assert.equal(readInk("new").strokes.length, 2);
		assert.equal(readInk("old").strokes.length, 0, "moved, not copied");
		flushInk();
		forgetInkMemory();
		assert.equal(readInk("new").strokes.length, 2, "and it survives a reload");
	});

	it("leaves a page that already has ink, and a different node, alone", () => {
		writeInk("old", inkFromStrokes([stroke(1)]));
		writeInk("new", inkFromStrokes([stroke(9)]));
		assert.equal(carryInkToReask(msgs(call("old", "n1"), call("new", "n1", "input-available")), "new", { nodeId: "n1" }), false);
		assert.equal(readInk("new").strokes.length, 1);
		assert.equal(readInk("old").strokes.length, 1);
		writeInk("o2", inkFromStrokes([stroke(3)]));
		assert.equal(carryInkToReask(msgs(call("o2", "n1"), call("n2", "n2", "input-available")), "n2", { nodeId: "n2" }), false);
	});
});
