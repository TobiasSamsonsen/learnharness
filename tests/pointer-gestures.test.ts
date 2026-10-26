/**
 * Pure tests for the shared touch gestures (components/pointer-gestures.ts):
 * one pointer pans (locked at the fit floor), two pan by the centroid and
 * zoom by the spread about the centroid, fingers joining or leaving
 * re-anchor without a jump, the floor re-fits, the ceiling holds.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZOOM_MAX, fitGraphView } from "../components/pan-zoom.ts";
import { GestureTracker, gestureView, type GestureSurface } from "../components/pointer-gestures.ts";

const surface: GestureSurface = { floor: 0.5, box: { w: 2000, h: 1000 }, viewport: { w: 800, h: 600 } };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

describe("gestureView", () => {
	it("one pointer pans by its delta", () => {
		const v = gestureView({ zoom: 1, x: -100, y: -50 }, [{ x: 10, y: 10 }], [{ x: 40, y: 25 }], surface);
		assert.deepEqual(v, { zoom: 1, x: -70, y: -35 });
	});

	it("one pointer at the floor does not pan — nothing to move", () => {
		const start = { zoom: surface.floor, x: 0, y: 0 };
		assert.equal(gestureView(start, [{ x: 0, y: 0 }], [{ x: 50, y: 50 }], surface), start);
	});

	it("two pointers moving together pan by the centroid, zoom unchanged", () => {
		const v = gestureView(
			{ zoom: 1, x: 0, y: 0 },
			[{ x: 100, y: 100 }, { x: 200, y: 100 }],
			[{ x: 130, y: 120 }, { x: 230, y: 120 }],
			surface,
		);
		near(v.zoom, 1);
		near(v.x, 30);
		near(v.y, 20);
	});

	it("pinching out zooms about the centroid: the content under it stays put", () => {
		const start = { zoom: 1, x: -200, y: -100 };
		const from = [{ x: 300, y: 300 }, { x: 500, y: 300 }];
		const to = [{ x: 200, y: 300 }, { x: 600, y: 300 }]; // spread ×2, same centroid (400,300)
		const v = gestureView(start, from, to, surface);
		near(v.zoom, 2);
		// content point under the centroid before: ((400-(-200))/1, (300-(-100))/1) = (600, 400)
		near(v.x + 600 * v.zoom, 400);
		near(v.y + 400 * v.zoom, 300);
	});

	it("pinching in past the floor re-fits and re-centers", () => {
		const start = { zoom: 0.6, x: -300, y: -100 };
		const v = gestureView(start, [{ x: 0, y: 0 }, { x: 400, y: 0 }], [{ x: 190, y: 0 }, { x: 210, y: 0 }], surface);
		assert.deepEqual(v, fitGraphView(surface.box, surface.viewport, surface.floor));
	});

	it("pinching out stops at the ceiling", () => {
		const v = gestureView({ zoom: 3, x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 0, y: 0 }, { x: 1000, y: 0 }], surface);
		assert.equal(v.zoom, ZOOM_MAX);
	});

	it("coincident start pointers do not divide by zero", () => {
		const v = gestureView({ zoom: 1, x: 0, y: 0 }, [{ x: 5, y: 5 }, { x: 5, y: 5 }], [{ x: 9, y: 9 }, { x: 50, y: 50 }], surface);
		assert.ok(Number.isFinite(v.zoom) && Number.isFinite(v.x) && Number.isFinite(v.y));
	});
});

describe("GestureTracker", () => {
	it("a single finger pans; the flag says it moved; the last lift resets", () => {
		const t = new GestureTracker();
		t.down(1, { x: 0, y: 0 }, { zoom: 1, x: 0, y: 0 });
		const v = t.move(1, { x: 20, y: 5 }, surface);
		assert.deepEqual(v, { zoom: 1, x: 20, y: 5 });
		assert.equal(t.moved, true);
		assert.equal(t.up(1, v!), true);
		assert.equal(t.moved, false);
		assert.equal(t.count, 0);
	});

	it("an untracked pointer is ignored", () => {
		const t = new GestureTracker();
		assert.equal(t.move(9, { x: 1, y: 1 }, surface), null);
	});

	it("a second finger joining re-anchors: no jump, then it pinches", () => {
		const t = new GestureTracker();
		t.down(1, { x: 100, y: 100 }, { zoom: 1, x: 0, y: 0 });
		const panned = t.move(1, { x: 150, y: 100 }, surface)!; // x:50
		t.down(2, { x: 250, y: 100 }, panned);
		// Nothing has moved since the second finger landed: the view is unchanged.
		const still = t.move(2, { x: 250, y: 100 }, surface)!;
		assert.deepEqual(still, panned);
		const pinched = t.move(2, { x: 350, y: 100 }, surface)!; // spread 100 → 200
		near(pinched.zoom, 2);
	});

	it("lifting one of two fingers re-anchors at the current view: the remaining finger pans on from there", () => {
		const t = new GestureTracker();
		t.down(1, { x: 0, y: 0 }, { zoom: 1, x: 0, y: 0 });
		t.down(2, { x: 100, y: 0 }, { zoom: 1, x: 0, y: 0 });
		const zoomed = t.move(2, { x: 200, y: 0 }, surface)!;
		t.up(2, zoomed);
		const after = t.move(1, { x: 10, y: 0 }, surface)!;
		near(after.zoom, zoomed.zoom);
		near(after.x, zoomed.x + 10);
	});

	it("clear forgets every pointer (a pointercancel storm)", () => {
		const t = new GestureTracker();
		t.down(1, { x: 0, y: 0 }, { zoom: 1, x: 0, y: 0 });
		t.clear();
		assert.equal(t.count, 0);
		assert.equal(t.move(1, { x: 5, y: 5 }, surface), null);
	});
});
