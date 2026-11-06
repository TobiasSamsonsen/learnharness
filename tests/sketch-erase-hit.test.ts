/**
 * The stroke eraser's hit test (src/core/sketch.ts sketchStrokeHit) rejects a stroke by its bounding box before walking
 * its segments (owner, 2026-11-06: erasing many strokes froze the page for seconds). The box is only a shortcut: every answer
 * must be the one the plain walk gives. REFERENCE below is the walk as it was before, kept here verbatim.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SketchStroke } from "../src/core/contracts/sketch.ts";
import { eraseHits } from "../src/core/ink-bridge.ts";
import { sketchStrokeHit } from "../src/core/sketch.ts";

function REFERENCE(s: SketchStroke, x: number, y: number, r: number): boolean {
	const reach = r + s.size / 2;
	const p = s.points;
	let px = p[0]!, py = p[1]!;
	if (Math.hypot(x - px, y - py) <= reach) return true;
	for (let k = 3; k < p.length; k += 3) {
		const qx = p[k]!, qy = p[k + 1]!;
		const dx = qx - px, dy = qy - py;
		const len2 = dx * dx + dy * dy;
		const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / len2));
		if (Math.hypot(x - (px + t * dx), y - (py + t * dy)) <= reach) return true;
		px = qx;
		py = qy;
	}
	return false;
}

function rng(seed: number) {
	let s = seed;
	return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

function randomStrokes(r: () => number, n: number): SketchStroke[] {
	return Array.from({ length: n }, () => {
		const count = 1 + Math.floor(r() * 40); // 1 point is a dot
		let x = r() * 400, y = r() * 600;
		const points: number[] = [];
		for (let i = 0; i < count; i++) {
			x += (r() - 0.5) * 30;
			y += (r() - 0.5) * 30;
			points.push(x, y, 0.5);
		}
		return { size: 1 + r() * 9, points };
	});
}

describe("sketchStrokeHit — the bounding-box shortcut never changes an answer", () => {
	it("agrees with the plain walk on thousands of random strokes, pointers and radii (dots, long and short reaches)", () => {
		const r = rng(11);
		const strokes = randomStrokes(r, 200);
		let hits = 0, misses = 0;
		for (const s of strokes) {
			for (let i = 0; i < 40; i++) {
				const x = r() * 500 - 50, y = r() * 700 - 50;
				const radius = [0.5, 4, 20, 60, 400][i % 5]!; // 400: reaches everything
				const want = REFERENCE(s, x, y, radius);
				assert.equal(sketchStrokeHit(s, x, y, radius), want, `stroke size ${s.size}, point ${x.toFixed(1)},${y.toFixed(1)}, radius ${radius}`);
				if (want) hits++; else misses++;
			}
		}
		assert.ok(hits > 500 && misses > 500, `the sample has both outcomes (${hits} hits, ${misses} misses)`);
	});

	it("the edges of the box count: a pointer exactly one reach away still hits", () => {
		const s: SketchStroke = { size: 6, points: [100, 100, 0.5, 200, 100, 0.5] };
		const radius = 10; // reach 13
		assert.equal(sketchStrokeHit(s, 100, 113, radius), true, "directly beside the stroke, exactly at the reach");
		assert.equal(sketchStrokeHit(s, 100, 113.01, radius), false);
		assert.equal(sketchStrokeHit(s, 87, 100, radius), true, "beyond the first point, at the reach");
		assert.equal(sketchStrokeHit(s, 86.99, 100, radius), false);
		assert.equal(sketchStrokeHit(s, 213, 100, radius), true, "beyond the last point, at the reach");
	});

	it("a stroke with no points is never hit, and a stroke edited to a new length is measured again (the cache cannot go stale)", () => {
		assert.equal(sketchStrokeHit({ size: 4, points: [] }, 0, 0, 100), false);
		const s: SketchStroke = { size: 4, points: [0, 0, 0.5, 10, 0, 0.5] };
		assert.equal(sketchStrokeHit(s, 500, 500, 5), false, "far away");
		s.points.push(500, 500, 0.5); // grown in place: the box must follow
		assert.equal(sketchStrokeHit(s, 500, 500, 5), REFERENCE(s, 500, 500, 5));
		assert.equal(sketchStrokeHit(s, 500, 500, 5), true);
	});
});

describe("eraseHits — the same strokes as before, from a long sweep", () => {
	it("returns exactly the indexes the plain walk finds, in order", () => {
		const r = rng(5);
		const strokes = randomStrokes(r, 150);
		const sweep: number[] = [];
		for (let i = 0; i < 300; i++) sweep.push(r() * 450, r() * 650);
		const radius = 15;
		const want: number[] = [];
		strokes.forEach((s, index) => {
			for (let k = 0; k + 1 < sweep.length; k += 2) {
				if (REFERENCE(s, sweep[k]!, sweep[k + 1]!, radius)) {
					want.push(index);
					return;
				}
			}
		});
		assert.ok(want.length > 20 && want.length < 150, `a mixed result (${want.length} of 150)`);
		assert.deepEqual(eraseHits(strokes, sweep, radius), want);
	});
});
