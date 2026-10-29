/** Straight lines (M16c): the snap, the line a held stroke becomes and the hold rule. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANGLE_SNAP_DEG, HOLD_MS, HOLD_RADIUS, isHeld, linePoints, snapAngle, straightenStroke } from "../components/sketch/straight-line.ts";
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
