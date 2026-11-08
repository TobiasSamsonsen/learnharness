/** The angle guide for straightened lines: which stored strokes are straight lines, and the angle a held line makes with the nearest one. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ARC_MAX_PX,
	ARC_MIN_PX,
	closestPoint,
	lineAngle,
	NEAR_PX,
	straightSegment,
	straightSegments,
	type Segment,
} from "../components/sketch/line-angle.ts";
import { linePoints } from "../components/sketch/straight-line.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);
const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;
const seg = (a: { x: number; y: number }, b: { x: number; y: number }): Segment => straightSegment(linePoints(a, b))!;
/** The end of a line of `len` from `from`, `angle` degrees clockwise from +x (y down). */
const toward = (from: { x: number; y: number }, angle: number, len: number) => ({ x: from.x + Math.cos(rad(angle)) * len, y: from.y + Math.sin(rad(angle)) * len });

describe("straightSegment", () => {
	it("recognises a line as linePoints writes it, at any angle", () => {
		const s = straightSegment(linePoints({ x: 10, y: 20 }, { x: 110, y: 20 }));
		assert.deepEqual(s, { a: { x: 10, y: 20 }, b: { x: 110, y: 20 } });
		const diagonal = straightSegment(linePoints({ x: 0, y: 0 }, { x: 70, y: 40 }));
		assert.ok(diagonal);
		near(diagonal.b.x, 70);
		near(diagonal.b.y, 40);
	});

	it("rejects a wobbly stroke, a stroke with uneven gaps, a dot and a stroke of one point", () => {
		assert.equal(straightSegment([0, 0, 0.5, 40, 3, 0.5, 80, 0, 0.5, 120, 4, 0.5]), null, "off the line by more than half a pixel");
		assert.equal(straightSegment([0, 0, 0.5, 5, 0, 0.5, 60, 0, 0.5, 100, 0, 0.5]), null, "collinear but not evenly spaced");
		assert.equal(straightSegment([3, 3, 0.5, 3, 3, 0.5]), null, "a dot");
		assert.equal(straightSegment([1, 2, 0.5]), null);
		assert.equal(straightSegment([]), null);
	});

	it("rejects a line too short to have a direction", () => {
		assert.equal(straightSegment([0, 0, 0.5, 4, 0, 0.5]), null);
		assert.ok(straightSegment([0, 0, 0.5, 6, 0, 0.5]));
	});

	it("keeps the straight ones from a list of strokes", () => {
		const strokes = [{ points: linePoints({ x: 0, y: 0 }, { x: 50, y: 0 }) }, { points: [0, 0, 0.5, 40, 9, 0.5, 90, 1, 0.5] }, { points: linePoints({ x: 0, y: 5 }, { x: 0, y: 65 }) }];
		assert.equal(straightSegments(strokes).length, 2);
	});
});

describe("closestPoint", () => {
	const s: Segment = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };

	it("projects onto the segment and stops at its ends", () => {
		assert.deepEqual(closestPoint({ x: 40, y: 7 }, s), { x: 40, y: 0 });
		assert.deepEqual(closestPoint({ x: -20, y: 5 }, s), { x: 0, y: 0 });
		assert.deepEqual(closestPoint({ x: 180, y: -5 }, s), { x: 100, y: 0 });
	});
});

describe("lineAngle", () => {
	const horizontal = [seg({ x: 0, y: 0 }, { x: 100, y: 0 })];
	const start = { x: 50, y: 6 };

	it("measures the angle at the point of the other line closest to the start", () => {
		const g = lineAngle(start, toward(start, 60, 80), horizontal, 1)!;
		assert.ok(g);
		assert.equal(g.degrees, 60);
		assert.deepEqual(g.vertex, { x: 50, y: 0 });
		near(deg(g.from), 60);
		near(deg(g.sweep), -60, 1e-9); // from the new line round to the other line's +x ray
	});

	it("always shows the smaller angle, turning the other line's ray to the side the new line leans", () => {
		const g = lineAngle(start, toward(start, 120, 80), horizontal, 1)!;
		assert.equal(g.degrees, 60, "120 degrees to one ray is 60 to the other");
		near(deg(g.from), 120);
		near(deg(g.sweep), 60, 1e-9);
		const right = lineAngle(start, toward(start, 90, 80), horizontal, 1)!;
		assert.equal(right.degrees, 90);
		assert.ok(Math.abs(right.sweep) <= Math.PI / 2 + 1e-9);
	});

	it("sits on an end of the other line when the start is beyond it", () => {
		const g = lineAngle({ x: -5, y: 3 }, toward({ x: -5, y: 3 }, 45, 60), horizontal, 1)!;
		assert.deepEqual(g.vertex, { x: 0, y: 0 });
		assert.equal(g.degrees, 45);
	});

	it("shows nothing for lines that are parallel to within a degree", () => {
		assert.equal(lineAngle(start, toward(start, 0.5, 80), horizontal, 1), null);
		assert.equal(lineAngle(start, toward(start, 180, 80), horizontal, 1), null);
		assert.ok(lineAngle(start, toward(start, 2, 80), horizontal, 1));
	});

	it("needs the start within NEAR_PX of the other line on screen, whatever the zoom", () => {
		const far = { x: 50, y: 20 };
		const out = toward(far, 60, 80);
		assert.equal(lineAngle(far, out, horizontal, 1), null, "20 px away at zoom 1");
		assert.ok(lineAngle(far, out, horizontal, 0.5), "10 px on screen at zoom 0.5");
		assert.equal(lineAngle(far, out, horizontal, 2), null, "40 px on screen at zoom 2");
		const edge = { x: 50, y: NEAR_PX };
		assert.ok(lineAngle(edge, toward(edge, 60, 80), horizontal, 1), "exactly NEAR_PX still counts");
	});

	it("measures against the nearest line when several are close", () => {
		const lines = [seg({ x: 0, y: -8 }, { x: 100, y: -8 }), seg({ x: 50, y: 0 }, { x: 100, y: 40 }), seg({ x: 50, y: -10 }, { x: 50, y: -60 })];
		const g = lineAngle({ x: 50, y: 0 }, toward({ x: 50, y: 0 }, 90, 80), lines, 1)!;
		assert.equal(g.degrees, Math.round(90 - deg(Math.atan2(40, 50))), "the line through the start itself, not the ones 8 and 10 px off");
	});

	it("keeps the arc radius a share of the new line between the bounds, and inside the other line", () => {
		const r = (len: number, lines = horizontal, zoom = 1) => lineAngle(start, toward(start, 60, len), lines, zoom)!.radiusPx;
		near(r(200), 50);
		near(r(10), ARC_MIN_PX);
		near(r(2000), ARC_MAX_PX);
		near(r(200, horizontal, 2), 80, 1e-9); // 0.25 * 200 * 2 = 100, capped at the maximum
		const short = [seg({ x: 40, y: 0 }, { x: 60, y: 0 })];
		near(r(2000, short), 20, 1e-9);
	});

	it("shows nothing for a line of no length or a zoom that cannot be", () => {
		assert.equal(lineAngle(start, start, horizontal, 1), null);
		assert.equal(lineAngle(start, toward(start, 60, 80), horizontal, 0), null);
		assert.equal(lineAngle(start, toward(start, 60, 80), [], 1), null);
	});
});
