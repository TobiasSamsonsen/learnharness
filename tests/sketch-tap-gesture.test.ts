/** The two-finger tap rule (M16b): quick, together, without travelling. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liftTap, moveTap, startTap, TAP_MAX_MOVE, TAP_MAX_MS } from "../components/sketch/tap-gesture.ts";

const fingers = new Map([
	[1, { x: 100, y: 100 }],
	[2, { x: 200, y: 100 }],
]);

describe("the two-finger tap", () => {
	it("counts when both fingers lift quickly without travelling", () => {
		const t = startTap(1000, fingers);
		const first = liftTap(moveTap(t, fingers), 1100);
		assert.equal(first.tapped, false, "one finger up is not yet a tap");
		const second = liftTap(first.tracker, 1150);
		assert.equal(second.tapped, true);
	});

	it("is not a tap when slow", () => {
		const t = startTap(1000, fingers);
		assert.equal(liftTap(t, 1000 + TAP_MAX_MS + 1).tapped, false);
		const first = liftTap(t, 1100);
		assert.equal(liftTap(first.tracker, 1000 + TAP_MAX_MS + 1).tapped, false, "the second lift came too late");
	});

	it("is not a tap when a finger travelled (a pinch or a pan)", () => {
		const t = startTap(1000, fingers);
		const moved = moveTap(t, new Map([[1, { x: 100, y: 100 }], [2, { x: 200 + TAP_MAX_MOVE + 1, y: 100 }]]));
		assert.equal(moved.cancelled, true);
		assert.equal(liftTap(liftTap(moved, 1050).tracker, 1100).tapped, false);
		// a little tremor is fine
		const shaky = moveTap(t, new Map([[1, { x: 104, y: 103 }], [2, { x: 198, y: 99 }]]));
		assert.equal(shaky.cancelled, false);
	});

	it("is not a tap with a third finger", () => {
		const t = startTap(1000, fingers);
		assert.equal(moveTap(t, new Map([...fingers, [3, { x: 150, y: 300 }]]), true).cancelled, true);
	});
});
