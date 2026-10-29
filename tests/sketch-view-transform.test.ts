import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clampZoom,
	eraserWorldRadius,
	fitInk,
	HOME_VIEW,
	MAX_ZOOM,
	MIN_ZOOM,
	panBy,
	penWorldSize,
	pinchOf,
	pinchStep,
	thinPath,
	toScreen,
	toWorld,
	zoomAbout,
} from "../components/sketch/view-transform.ts";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

describe("the infinite canvas's view", () => {
	it("screen and world map back and forth, at any zoom and origin", () => {
		const view = { zoom: 2.5, x: -300, y: 120 };
		const w = toWorld(view, 410, 77);
		const s = toScreen(view, w.x, w.y);
		near(s.x, 410);
		near(s.y, 77);
	});

	it("zooming keeps the point under the finger where it is", () => {
		const view = { zoom: 1, x: 40, y: -10 };
		const before = toWorld(view, 200, 150);
		const after = zoomAbout(view, 3, 200, 150);
		const now = toWorld(after, 200, 150);
		near(now.x, before.x);
		near(now.y, before.y);
		near(after.zoom, 3);
	});

	it("zoom stays between the limits, and the anchor still holds at a limit", () => {
		assert.equal(clampZoom(100), MAX_ZOOM);
		assert.equal(clampZoom(0.001), MIN_ZOOM);
		const out = zoomAbout(HOME_VIEW, 1000, 50, 50);
		assert.equal(out.zoom, MAX_ZOOM);
		const w = toWorld(out, 50, 50);
		near(w.x, 50);
		near(w.y, 50);
	});

	it("a drag moves the content with the finger, at any zoom", () => {
		const view = { zoom: 4, x: 0, y: 0 };
		const moved = panBy(view, 40, -20);
		// the world point that was under (100, 100) is now under (140, 80)
		const was = toWorld(view, 100, 100);
		const s = toScreen(moved, was.x, was.y);
		near(s.x, 140);
		near(s.y, 80);
	});

	it("the pen feels the same on screen at any zoom, inside what the validator accepts", () => {
		assert.equal(penWorldSize(4, 1), 4);
		assert.equal(penWorldSize(4, 2), 2);
		assert.equal(penWorldSize(2, 8), 0.5, "thin at the top zoom is clamped to the validator's floor, not 0.25");
		assert.equal(penWorldSize(8, 0.1), 64, "thick at the bottom zoom is clamped to the ceiling, not 80");
	});

	it("the eraser's screen radius is a smaller world radius when zoomed in", () => {
		assert.equal(eraserWorldRadius(20, 1), 20);
		assert.equal(eraserWorldRadius(20, 4), 5);
		assert.equal(eraserWorldRadius(20, 0.5), 40);
	});

	it("opens at home when the ink fits, else shows all of it", () => {
		const small = [[10, 10, 0.5, 200, 100, 0.5]];
		assert.deepEqual(fitInk(small, 800, 600), HOME_VIEW);
		assert.deepEqual(fitInk([], 800, 600), HOME_VIEW);
		const big = [[-2000, -1000, 0.5, 3000, 2000, 0.5]];
		const v = fitInk(big, 800, 600);
		assert.ok(v.zoom < 1 && v.zoom >= MIN_ZOOM);
		// both ends of the ink land inside the canvas
		const a = toScreen(v, -2000, -1000);
		const b = toScreen(v, 3000, 2000);
		assert.ok(a.x >= 0 && a.y >= 0 && b.x <= 800 && b.y <= 600, `${JSON.stringify([a, b])}`);
	});

	it("a pinch zooms about the fingers and follows them", () => {
		const view = { zoom: 1, x: 0, y: 0 };
		const prev = pinchOf({ x: 100, y: 100 }, { x: 200, y: 100 });
		const next = pinchOf({ x: 100, y: 100 }, { x: 300, y: 100 }); // spread: 2x
		const out = pinchStep(view, prev, next);
		near(out.zoom, 2);
		// the world point that was at the old midpoint is now at the new midpoint
		const anchor = toWorld(view, prev.mx, prev.my);
		const at = toScreen(out, anchor.x, anchor.y);
		near(at.x, next.mx, 1e-6);
		near(at.y, next.my, 1e-6);
		// no fingers apart (degenerate) leaves the zoom alone
		assert.equal(pinchStep(view, pinchOf({ x: 1, y: 1 }, { x: 1, y: 1 }), next).zoom, 1);
	});
});

describe("thinPath (the eraser's path, thinned before it is cut against)", () => {
	it("drops samples closer than the step, keeps the first and the last", () => {
		const path = [0, 0, 1, 0, 2, 0, 3, 0, 10, 0, 10.5, 0];
		assert.deepEqual(thinPath(path, 5), [0, 0, 10, 0, 10.5, 0]);
		assert.deepEqual(thinPath([0, 0, 1, 1], 5), [0, 0, 1, 1], "a dot or one segment is left alone");
		assert.deepEqual(thinPath(path, 0), path);
	});

	it("keeps the cut the same: thinned at a quarter of the radius, a pass cuts the same pieces", async () => {
		const { sketchStrokeCut } = await import("../src/core/index.ts");
		const stroke = { size: 4, points: Array.from({ length: 51 }, (_, i) => [i * 4, 0, 0.5]).flat() };
		const dense: number[] = [];
		for (let i = 0; i <= 400; i++) dense.push(20 + i * 0.5, 3 * Math.sin(i / 20)); // 400 samples across 200 px
		const radius = 10;
		const a = sketchStrokeCut(stroke, dense, radius)!;
		const b = sketchStrokeCut(stroke, thinPath(dense, radius / 4), radius)!;
		const ends = (cut: typeof a) => cut.flatMap((s) => [s.points[0], s.points[s.points.length - 3]]);
		assert.equal(a.length, b.length);
		ends(a).forEach((x, i) => assert.ok(Math.abs(x! - ends(b)[i]!) < 3, `end ${i}: ${x} vs ${ends(b)[i]}`));
	});

	it("is cheap: 300 strokes against a 2000-sample path, thinned, in well under a second", async () => {
		const { sketchStrokeCut } = await import("../src/core/index.ts");
		const strokes = Array.from({ length: 300 }, (_, i) => ({ size: 4, points: Array.from({ length: 40 }, (_, k) => [(i % 20) * 40 + k, Math.floor(i / 20) * 30, 0.5]).flat() }));
		const path: number[] = [];
		for (let i = 0; i < 2000; i++) path.push(i * 0.4, 100 + 80 * Math.sin(i / 100));
		const thin = thinPath(path, 20 / 4);
		const t0 = performance.now();
		for (const s of strokes) sketchStrokeCut(s, thin, 20);
		const ms = performance.now() - t0;
		console.log(`# 300 strokes x ${thin.length / 2}-point thinned path (from 2000): ${ms.toFixed(1)} ms`);
		assert.ok(ms < 1000, `${ms} ms`);
	});
});
