import assert from "node:assert/strict";
import { test } from "node:test";
import { horizontalShift } from "../components/use-keep-in-viewport.ts";

/** Android phone pass: the pure math behind keeping an absolutely positioned popover on the screen (412px phone). */

test("a popover that fits is left where it is", () => {
	assert.equal(horizontalShift({ left: 40, right: 328 }, 412), 0);
	assert.equal(horizontalShift({ left: 8, right: 404 }, 412), 0);
});

test("one that leaves the left edge moves right until it is 8px inside", () => {
	// the stats popover: 288px wide, centered on a trigger whose center is ~80px from the left
	assert.equal(horizontalShift({ left: -64, right: 224 }, 412), 72);
	assert.equal(horizontalShift({ left: 0, right: 288 }, 412), 8);
});

test("one that leaves the right edge moves left until it is 8px inside", () => {
	assert.equal(horizontalShift({ left: 200, right: 450 }, 412), -46);
});

test("one wider than the room goes flush to the left edge", () => {
	assert.equal(horizontalShift({ left: 30, right: 530 }, 412), -22);
	assert.equal(horizontalShift({ left: -40, right: 460 }, 412), 48);
});

test("an exactly full-width box counts as wider than the room", () => {
	assert.equal(horizontalShift({ left: 0, right: 396 }, 412), 8);
});
