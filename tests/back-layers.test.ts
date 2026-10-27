import assert from "node:assert/strict";
import test from "node:test";

// The module installs its `lh:back` listener on `window` at import time; give
// it a bare event target first (the node test runner has no DOM).
const win = new EventTarget();
(globalThis as unknown as { window: EventTarget }).window = win;
const { handleBack, registerBackLayer } = await import("../components/back-layers.ts");

const back = (): boolean => {
	const detail = { handled: false };
	win.dispatchEvent(new CustomEvent("lh:back", { detail }));
	return detail.handled;
};

test("back layers: nothing open → not handled", () => {
	assert.equal(handleBack(), false);
	assert.equal(back(), false);
});

test("back layers: the newest layer closes first, one per press", () => {
	const closed: string[] = [];
	const offA = registerBackLayer(() => { closed.push("a"); offA(); });
	const offB = registerBackLayer(() => { closed.push("b"); offB(); });
	assert.equal(back(), true);
	assert.deepEqual(closed, ["b"]);
	assert.equal(back(), true);
	assert.deepEqual(closed, ["b", "a"]);
	assert.equal(back(), false, "stack is empty again");
});

test("back layers: unregistering removes only that layer", () => {
	const closed: string[] = [];
	const offA = registerBackLayer(() => closed.push("a"));
	const offB = registerBackLayer(() => closed.push("b"));
	offA();
	assert.equal(handleBack(), true);
	assert.deepEqual(closed, ["b"]);
	offB();
	assert.equal(handleBack(), false);
	offA(); // a second unregister is harmless
});

test("back layers: a layer that stays open keeps answering", () => {
	let n = 0;
	const off = registerBackLayer(() => { n++; });
	assert.equal(back(), true);
	assert.equal(back(), true);
	assert.equal(n, 2);
	off();
});
