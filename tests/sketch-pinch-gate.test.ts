/** The pinch gate (owner, 2026-10-31): a resting palm must not zoom the sketch view. Numbers are from the Tab S10+ log. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPalmShaped, PALM_SHAPE_PX, PINCH_SETTLE_MS, pinchReady } from "../components/sketch/pinch-gate.ts";

describe("palm shape", () => {
	it("passes the fingertips of the deliberate pinches (4-7.5 px, roughly square, first reports 0.5 x 1)", () => {
		for (const [w, h] of [[4.5, 6], [4, 4], [4.5, 5.5], [3.5, 5.5], [5.5, 5.5], [6.5, 6.5], [7.5, 7.5], [7, 7], [0.5, 1], [1.5, 2], [2, 3]]) {
			assert.equal(isPalmShaped(w, h), false, `${w}x${h}`);
		}
	});

	it("catches the palm contacts of the log (tall or large)", () => {
		for (const [w, h] of [[6, 12], [9, 11.5], [6.5, 15], [6.5, 17], [19, 26.5], [17, 23.5], [10, 18]]) {
			assert.equal(isPalmShaped(w, h), true, `${w}x${h}`);
		}
	});

	it("takes either side of the patch, and treats a missing size as no palm", () => {
		assert.equal(isPalmShaped(PALM_SHAPE_PX, 1), true);
		assert.equal(isPalmShaped(1, PALM_SHAPE_PX), true);
		assert.equal(isPalmShaped(undefined, undefined), false);
		assert.equal(isPalmShaped(Number.NaN, 4), false);
	});
});

describe("when two touches may pinch", () => {
	const settled = (n: number) => Array.from({ length: n }, () => ({ downAt: 0, palm: false }));
	const later = PINCH_SETTLE_MS + 1;

	it("needs exactly two touches", () => {
		assert.equal(pinchReady(settled(1), later), false);
		assert.equal(pinchReady(settled(2), later), true);
		assert.equal(pinchReady(settled(3), later), false, "a third touch (a palm beside two fingers) ends the pinch");
		assert.equal(pinchReady(settled(0), later), false);
	});

	it("waits for both touches to settle", () => {
		assert.equal(pinchReady(settled(2), PINCH_SETTLE_MS - 1), false);
		assert.equal(pinchReady([{ downAt: 0, palm: false }, { downAt: 60, palm: false }], PINCH_SETTLE_MS + 30), false, "the later touch is still new");
		assert.equal(pinchReady([{ downAt: 0, palm: false }, { downAt: 60, palm: false }], 60 + PINCH_SETTLE_MS), true);
	});

	it("refuses a pair with a palm-shaped touch", () => {
		assert.equal(pinchReady([{ downAt: 0, palm: false }, { downAt: 0, palm: true }], later), false);
	});
});
