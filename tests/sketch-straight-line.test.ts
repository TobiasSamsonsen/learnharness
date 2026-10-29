/** Straight lines (M16c): the snap, the line a held stroke becomes, the hold rule and the ruler's snap. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANGLE_SNAP_DEG, dist, HOLD_MS, HOLD_RADIUS, isHeld, linePoints, MIN_LINE_PX, RULER_THICKNESS, rulerSnap, snapAngle, straightenStroke } from "../components/sketch/straight-line.ts";
import type { SketchStroke } from "../src/core";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

describe("snapAngle", () => {
	const o = { x: 0, y: 0 };

	it("snaps a line near horizontal, vertical or diagonal to it, keeping its length", () => {
		const to = snapAngle(o, { x: 100, y: 4 }); // about 2.3 degrees
		near(to.y, 0);
		near(to.x, Math.hypot(100, 4));
		const v = snapAngle(o, { x: -3, y: 80 });
		near(v.x, 0);
		near(v.y, Math.hypot(3, 80));
		const diag = snapAngle(o, { x: 100, y: 104 });
		near(diag.x, diag.y);
	});

	it("leaves a line that is not close to one", () => {
		const to = { x: 100, y: 30 }; // 16.7 degrees
		assert.deepEqual(snapAngle(o, to), to);
		const justOut = { x: 100, y: 100 * Math.tan(((ANGLE_SNAP_DEG + 0.5) * Math.PI) / 180) };
		assert.deepEqual(snapAngle(o, justOut), justOut);
	});

	it("does nothing for a zero-length line", () => {
		assert.deepEqual(snapAngle(o, o), o);
	});
});

describe("linePoints and straightenStroke", () => {
	it("writes both ends and evenly spaced points between", () => {
		const pts = linePoints({ x: 0, y: 0 }, { x: 60, y: 0 }, 0.7);
		assert.equal(pts.length % 3, 0);
		assert.deepEqual(pts.slice(0, 3), [0, 0, 0.7]);
		assert.deepEqual(pts.slice(-3), [60, 0, 0.7]);
		assert.equal(pts.length / 3, 11, "ten steps of six");
	});

	it("turns a wobbly stroke into a line from its start to its end, keeping size and colour", () => {
		const wobbly: SketchStroke = { size: 4, color: "#dc2626", points: [10, 10, 0.4, 40, 17, 0.6, 70, 6, 0.5, 110, 12, 0.5] };
		const line = straightenStroke(wobbly);
		assert.equal(line.size, 4);
		assert.equal(line.color, "#dc2626");
		assert.deepEqual(line.points.slice(0, 2), [10, 10]);
		const lastX = line.points[line.points.length - 3]!;
		const lastY = line.points[line.points.length - 2]!;
		near(lastY, 10, 1e-6); // 1.1 degrees: snapped to horizontal
		near(lastX, 10 + Math.hypot(100, 2), 1e-6);
		for (let i = 1; i < line.points.length; i += 3) near(line.points[i]!, 10, 1e-6);
	});

	it("can follow a given end (the pen moving while it holds)", () => {
		const s: SketchStroke = { size: 4, points: [0, 0, 0.5, 20, 3, 0.5] };
		const line = straightenStroke(s, { x: 50, y: 50 });
		near(line.points[line.points.length - 3]!, 50);
		near(line.points[line.points.length - 2]!, 50);
	});
});

describe("isHeld", () => {
	const at = (x: number, y: number, t: number) => ({ x, y, t });

	it("is true once the pen has stayed put for HOLD_MS", () => {
		const samples = [at(0, 0, 0), at(50, 0, 100), at(100, 0, 200), at(101, 1, 300), at(100, 0, 500), at(101, 0, 700)];
		assert.equal(isHeld(samples, 700), true);
	});

	it("is false while it still moves or has not waited long enough", () => {
		assert.equal(isHeld([at(0, 0, 0), at(50, 0, 100), at(100, 0, 600)], 600), false, "it moved 50 px 500 ms ago, only 0 ms still");
		assert.equal(isHeld([at(100, 0, 0), at(100, 0, HOLD_MS - 100)], HOLD_MS - 100), false);
		assert.equal(isHeld([at(100, 0, 0), at(100, 0, HOLD_MS)], HOLD_MS), true);
		assert.equal(isHeld([at(100, 0, 0), at(100, 0, HOLD_MS - 5)], HOLD_MS - 5), true, "a timer that fired a little early still counts");
	});

	it("allows a little tremor, but not more than HOLD_RADIUS", () => {
		assert.equal(isHeld([at(0, 0, 0), at(HOLD_RADIUS, 0, 600)], 600), true);
		assert.equal(isHeld([at(0, 0, 0), at(HOLD_RADIUS + 1, 0, 600)], 600), false);
	});

	it("is false for no samples; a pen that has not moved since its only sample counts as held", () => {
	assert.equal(isHeld([], 1000), false);
	assert.equal(isHeld([at(0, 0, 0)], HOLD_MS + 1), true);
	assert.equal(isHeld([at(0, 0, 0)], 100), false);
	});
});

describe("the ruler", () => {
	// a horizontal ruler from (100, 200) to (400, 200); its top edge is at y = 200 - 18, its bottom edge at 200 + 18
	const ruler = { a: { x: 100, y: 200 }, b: { x: 400, y: 200 } };
	const half = RULER_THICKNESS / 2;

	it("draws a stroke along the edge it started beside onto that edge", () => {
		const above = [
			{ x: 150, y: 200 - half - 6 },
			{ x: 220, y: 200 - half - 9 },
			{ x: 300, y: 200 - half - 4 },
		];
		const [p, q] = rulerSnap(above, ruler)!;
		near(p.x, 150);
		near(q.x, 300);
		near(p.y, 200 - half);
		near(q.y, 200 - half);
		const below = [
			{ x: 150, y: 200 + half + 6 },
			{ x: 300, y: 200 + half + 8 },
		];
		const [r, s] = rulerSnap(below, ruler)!;
		near(r.y, 200 + half);
		near(s.y, 200 + half);
	});

	it("keeps the line on the ruler: ends beyond it are clamped to its ends", () => {
		const long = [
			{ x: 60, y: 200 - half - 5 },
			{ x: 440, y: 200 - half - 5 },
		];
		assert.equal(rulerSnap(long, ruler), null, "starting past the end is not along the ruler");
		const over = [
			{ x: 120, y: 200 - half - 5 },
			{ x: 440, y: 200 - half - 5 },
		];
		const [, q] = rulerSnap(over, ruler)!;
		near(q.x, 400, 1e-6);
	});

	it("works for a tilted ruler: the edge follows the angle", () => {
		const tilted = { a: { x: 0, y: 0 }, b: { x: 300, y: 300 } };
		const n = { x: -Math.SQRT1_2, y: Math.SQRT1_2 }; // the normal
		const start = { x: 50 + n.x * (half + 6), y: 50 + n.y * (half + 6) };
		const end = { x: 200 + n.x * (half + 6), y: 200 + n.y * (half + 6) };
		const [p, q] = rulerSnap([start, end], tilted)!;
		near(dist(p, q), 150 * Math.SQRT2, 1e-6);
		near((q.y - p.y) / (q.x - p.x), 1, 1e-9);
	});

	it("leaves a stroke that is far away, wanders, crosses, or is too short", () => {
		const far = [
			{ x: 150, y: 100 },
			{ x: 300, y: 100 },
		];
		assert.equal(rulerSnap(far, ruler), null, "too far from the edge");
		const wavy = [
			{ x: 150, y: 150 },
			{ x: 200, y: 135 },
			{ x: 250, y: 150 },
			{ x: 300, y: 128 },
		];
		assert.equal(rulerSnap(wavy, ruler), null, "wanders off the run");
		const crossing = [
			{ x: 250, y: 150 },
			{ x: 250, y: 250 },
		];
		assert.equal(rulerSnap(crossing, ruler), null, "runs across, not along");
		const tick = [
			{ x: 250, y: 160 },
			{ x: 250 + MIN_LINE_PX - 2, y: 160 },
		];
		assert.equal(rulerSnap(tick, ruler), null, "too short");
		assert.equal(rulerSnap([{ x: 250, y: 160 }], ruler), null);
		assert.equal(rulerSnap(tick, { a: { x: 5, y: 5 }, b: { x: 5, y: 5 } }), null, "a ruler with no length");
	});
});
