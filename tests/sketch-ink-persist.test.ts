/**
 * Unsent ink is written to storage after a pause in drawing, not on every stroke (the write stringifies the whole page and
 * its history); a hidden or closing page writes at once; a refused write (the quota) is reported, not swallowed.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const store = new Map<string, string>();
let quota = Infinity;
let totalQuota = Infinity;
const total = () => [...store].reduce((n, [k, v]) => n + k.length + v.length, 0);
let writes = 0;
(globalThis as unknown as { localStorage: Storage }).localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => {
		if (v.length > quota) throw new DOMException("full", "QuotaExceededError");
		if (total() - (store.has(k) ? k.length + store.get(k)!.length : 0) + k.length + v.length > totalQuota) throw new DOMException("full", "QuotaExceededError");
		writes++;
		store.set(k, v);
	},
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
	key: (i: number) => [...store.keys()][i] ?? null,
	get length() {
		return store.size;
	},
} as Storage;

const { writeInk, flushInk, forgetInkMemory, readInk, inkSaveFailed, dropRedundantInk, PERSIST_DELAY_MS } = await import("../components/sketch/ink-memory.ts");
import type { SketchStroke } from "../src/core";
import type { InkState } from "../components/sketch/ink-memory.ts";
import { limitShare, sketchStatus } from "../components/sketch/sketch-status.ts";

const stroke = (n: number): SketchStroke => ({ size: 4, points: [n, n, 0.5, n + 10, n + 10, 0.5] });
const page = (count: number): InkState => {
	const strokes = Array.from({ length: count }, (_, i) => stroke(i));
	return { strokes, undo: strokes.map((s) => ({ kind: "add" as const, stroke: s })), redo: [] };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("writing the ink to storage", () => {
	beforeEach(() => {
		flushInk();
		store.clear();
		forgetInkMemory();
		quota = Infinity;
		totalQuota = Infinity;
		writes = 0;
	});

	it("waits for a pause, then writes the newest state once", async () => {
		for (let i = 1; i <= 5; i++) writeInk("p1", page(i));
		assert.equal(store.has("lh:ink:p1"), false, "nothing is written while strokes keep coming");
		assert.equal(readInk("p1").strokes.length, 5, "memory is current at once");
		await sleep(PERSIST_DELAY_MS + 150);
		assert.equal(JSON.parse(store.get("lh:ink:p1")!).length, 5, "the pause writes the newest page");
		assert.equal(writes, 2, "one write for the strokes and one for the history, not five of each");
	});

	it("writes at once when asked (the page is being hidden)", () => {
		writeInk("p2", page(3));
		flushInk();
		assert.equal(JSON.parse(store.get("lh:ink:p2")!).length, 3);
	});

	it("a reload restores what a flush wrote", () => {
		writeInk("p3", page(4));
		forgetInkMemory(); // stands for pagehide and the reload
		assert.equal(readInk("p3").strokes.length, 4);
	});

	it("clearing is written too", () => {
		writeInk("p4", page(2));
		flushInk();
		writeInk("p4", { strokes: [], undo: [], redo: [] });
		flushInk();
		assert.equal(store.has("lh:ink:p4"), false);
	});

	it("reports a refused write, and stops reporting once one goes through", () => {
		quota = 10;
		writeInk("p5", page(3));
		flushInk();
		assert.equal(inkSaveFailed("p5"), true);
		quota = Infinity;
		writeInk("p5", page(3));
		flushInk();
		assert.equal(inkSaveFailed("p5"), false);
	});
});

describe("a full store", () => {
	beforeEach(() => {
		flushInk();
		store.clear();
		forgetInkMemory();
		quota = Infinity;
		totalQuota = Infinity;
	});

	it("frees other pages' undo history to fit the page being drawn, and keeps their ink", () => {
		writeInk("old", page(40));
		flushInk();
		const oldInk = store.get("lh:ink:old")!;
		assert.ok(store.has("lh:ink-hist:old"));
		totalQuota = total() + 20; // no room for even a small new page
		writeInk("new", page(3));
		flushInk();
		assert.equal(inkSaveFailed("new"), false, "the write went through after eviction");
		assert.equal(JSON.parse(store.get("lh:ink:new")!).length, 3);
		assert.equal(store.has("lh:ink-hist:old"), false, "the old page's history was evicted");
		assert.equal(store.get("lh:ink:old"), oldInk, "the old page's ink was not touched");
	});

	it("reports the failure when the page itself does not fit", () => {
		writeInk("old", page(40));
		flushInk();
		totalQuota = total() + 10;
		writeInk("big", page(200));
		flushInk();
		assert.equal(inkSaveFailed("big"), true);
		assert.ok(store.has("lh:ink:old"), "other ink survives");
	});

	it("drops a restored page that is exactly what the server holds, and only then", () => {
		const p = page(5);
		writeInk("dup", p);
		flushInk();
		forgetInkMemory(); // a reload before the commit: the sent page comes back as unsent ink
		const kept = p.strokes.map((s) => ({ ...s }));
		assert.equal(dropRedundantInk("dup", [kept[0]!]), false, "a different page is not dropped");
		assert.equal(readInk("dup").strokes.length, 5);
		assert.equal(dropRedundantInk("dup", kept), true);
		flushInk();
		assert.equal(readInk("dup").strokes.length, 0);
		assert.equal(store.has("lh:ink:dup"), false);
	});
});

describe("the status line", () => {
	const base = { error: null, nativeFallback: null, disabled: false, keptStatus: "ready" as const, share: 0 };

	it("says when the page could not be saved on this device", () => {
		assert.deepEqual(sketchStatus({ ...base, saveFailed: true }), { kind: "error", text: "This page is NOT saved on this device (storage is full). Send it now so the ink isn't lost." });
		assert.equal(sketchStatus({ ...base, saveFailed: false }), null);
	});

	it("counts a second list of strokes toward the page's share", () => {
		const s = { points: [0, 0, 0.5, 1, 1, 0.5] };
		assert.equal(limitShare([s, s], [s]), limitShare([s, s, s]));
	});
});
