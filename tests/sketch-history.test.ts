/**
 * Undo survives a reload (M16b, docs/android/m16-plan.md): the last operations of each stack are stored with the unsent
 * ink and trusted only when they match the strokes that come back.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
	key: () => null,
	length: 0,
} as Storage;

const { readInk, writeInk, forgetInkMemory, commitSketch, writeKept, applyOp, revertOp, HISTORY_OPS, validOp } = await import("../components/sketch/ink-memory.ts");
import type { SketchStroke } from "../src/core";
import type { InkOp, InkState } from "../components/sketch/ink-memory.ts";

const stroke = (n: number): SketchStroke => ({ size: 4, points: [n, n, 0.5, n + 10, n + 10, 0.5] });

/** An ink state built the way the view builds it: every stroke added through an operation. */
function drawn(count: number): InkState {
	let state: InkState = { strokes: [], undo: [], redo: [] };
	for (let i = 0; i < count; i++) {
		const s = stroke(i);
		state = { strokes: [...state.strokes, s], undo: [...state.undo, { kind: "add", stroke: s }], redo: [] };
	}
	return state;
}

describe("the undo history across a reload", () => {
	beforeEach(() => {
		store.clear();
		forgetInkMemory();
	});

	it("comes back with the strokes: undo and redo still work", () => {
		const state = drawn(3);
		const undone = state.undo[2]!;
		writeInk("h1", { strokes: revertOp(state.strokes, undone), undo: state.undo.slice(0, 2), redo: [undone] });
		forgetInkMemory();
		const back = readInk("h1");
		assert.equal(back.strokes.length, 2);
		assert.equal(back.undo.length, 2, "the history is there");
		assert.equal(back.redo.length, 1, "and the redo stack");
		assert.deepEqual(applyOp(back.strokes, back.redo[0]!).length, 3);
	});

	it("keeps only the last operations of each stack", () => {
		writeInk("h2", drawn(HISTORY_OPS + 10));
		forgetInkMemory();
		const back = readInk("h2");
		assert.equal(back.strokes.length, HISTORY_OPS + 10, "every stroke is kept");
		assert.equal(back.undo.length, HISTORY_OPS, "the history is capped");
	});

	it("is dropped when it does not match the strokes (undo then falls back to the newest stroke)", () => {
		writeInk("h3", drawn(3));
		// the strokes change under it, as if another tab wrote them
		store.set("lh:ink:h3", JSON.stringify(drawn(4).strokes));
		forgetInkMemory();
		const back = readInk("h3");
		assert.equal(back.strokes.length, 4);
		assert.equal(back.undo.length, 0);
	});

	it("is dropped when it is damaged", () => {
		writeInk("h4", drawn(2));
		store.set("lh:ink-hist:h4", "{not json");
		forgetInkMemory();
		assert.equal(readInk("h4").undo.length, 0);
		writeInk("h4", drawn(2));
		const text = JSON.parse(store.get("lh:ink-hist:h4")!) as { undo: unknown[] };
		text.undo.push({ kind: "bogus" });
		store.set("lh:ink-hist:h4", JSON.stringify(text));
		forgetInkMemory();
		assert.equal(readInk("h4").undo.length, 0, "one bad operation voids the history");
	});

	it("ends at a submit: sent ink is protected, so its history goes", () => {
		const state = drawn(2);
		writeInk("h5", state);
		writeKept("h5", { id: "sk_old", strokes: [] });
		commitSketch("h5", { id: "sk_new", producer: "web-canvas", strokes: state.strokes } as never, state.strokes);
		assert.equal(store.get("lh:ink-hist:h5"), undefined);
		forgetInkMemory();
		assert.equal(readInk("h5").strokes.length, 0);
	});

	it("validates every kind of operation", () => {
		const a = stroke(1);
		const ops: InkOp[] = [
			{ kind: "add", stroke: a },
			{ kind: "erase", removed: [{ index: 0, stroke: a }] },
			{ kind: "clear", removed: [a] },
			{ kind: "cut", changes: [{ index: 0, stroke: a, pieces: [a] }] },
		];
		for (const op of ops) assert.equal(validOp(op), true, op.kind);
		for (const bad of [null, 3, {}, { kind: "add" }, { kind: "add", stroke: { size: 4, points: [1, 2] } }, { kind: "cut", changes: [{ index: "0" }] }]) {
			assert.equal(validOp(bad), false, JSON.stringify(bad));
		}
	});
});
