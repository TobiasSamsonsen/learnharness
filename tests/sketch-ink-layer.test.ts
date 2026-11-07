import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advanceCut, isAppend, layerBlit, layerGeometry, layerWorldRect, LAYER_MAX_SIDE, newCut, sameSet, sameStrokes, strokeVisible } from "../components/sketch/ink-layer.ts";
import { sketchStrokeCut, type SketchStroke } from "../src/core/index.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const line = (x0: number, y0: number, x1: number, y1: number, size = 4): SketchStroke => ({ size, points: [x0, y0, 0.5, x1, y1, 0.5] });

describe("the cached ink layer's geometry", () => {
	it("covers the viewport plus a quarter of it on each side", () => {
		const g = layerGeometry(400, 800, 2);
		assert.equal(g.mx, 100);
		assert.equal(g.my, 200);
		assert.equal(g.scale, 2);
		assert.equal(g.width, 1200);
		assert.equal(g.height, 2400);
	});

	it("drops to a lower density rather than exceed the bitmap limit", () => {
		const g = layerGeometry(6000, 3000, 2);
		assert.ok(Math.max(g.width, g.height) <= LAYER_MAX_SIDE);
		assert.ok(g.scale < 2);
	});

	it("covers the world around the view it was drawn at", () => {
		const g = layerGeometry(400, 800, 1);
		const r = layerWorldRect({ zoom: 2, x: 50, y: -10 }, g);
		near(r.minX, 50 - 100 / 2);
		near(r.maxX, 50 + 500 / 2);
		near(r.minY, -10 - 200 / 2);
		near(r.maxY, -10 + 1000 / 2);
	});

	it("blits one-to-one at the view it was drawn at, in the margin's shadow", () => {
		const g = layerGeometry(400, 800, 2);
		const v = { zoom: 1.5, x: 30, y: 40 };
		const b = layerBlit(v, v, g);
		near(b.x, -g.mx);
		near(b.y, -g.my);
		near(b.w, g.width / g.scale);
		near(b.h, g.height / g.scale);
	});

	it("moves with a pan and scales with a zoom", () => {
		const g = layerGeometry(400, 800, 1);
		const drawn = { zoom: 1, x: 0, y: 0 };
		// the content follows a drag of 30 px to the right: the view's x goes down by 30
		const panned = layerBlit(drawn, { zoom: 1, x: -30, y: 0 }, g);
		near(panned.x, -g.mx + 30);
		// zoomed 2x about the origin: the layer is twice as large and its corner twice as far out
		const zoomed = layerBlit(drawn, { zoom: 2, x: 0, y: 0 }, g);
		near(zoomed.w, (g.width / g.scale) * 2);
		near(zoomed.x, -g.mx * 2);
	});
});

describe("culling", () => {
	const rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

	it("keeps a stroke inside the rect and one that only its width reaches in", () => {
		assert.equal(strokeVisible(line(10, 10, 50, 50), rect), true);
		assert.equal(strokeVisible(line(-3, 20, -3, 40, 8), rect), true);
	});

	it("drops a stroke wholly outside the rect", () => {
		assert.equal(strokeVisible(line(-50, 20, -20, 40), rect), false);
		assert.equal(strokeVisible(line(10, 300, 40, 400), rect), false);
	});

	it("drops a stroke with no points", () => {
		assert.equal(strokeVisible({ size: 4, points: [] }, rect), false);
	});
});

describe("telling what changed", () => {
	const a = line(0, 0, 1, 1);
	const b = line(1, 1, 2, 2);
	const c = line(2, 2, 3, 3);

	it("compares stroke lists by the objects in them", () => {
		assert.equal(sameStrokes([a, b], [a, b]), true);
		assert.equal(sameStrokes([a, b], [a, c]), false);
		assert.equal(sameStrokes([a, b], [a]), false);
		assert.equal(sameStrokes([a, b], [a, c], 1), true);
	});

	it("knows one stroke added at the end, and nothing else", () => {
		assert.equal(isAppend([a, b], [a, b, c]), true);
		assert.equal(isAppend([a, b], [a, c, b]), false);
		assert.equal(isAppend([a, b], [a, c]), false);
		assert.equal(isAppend([a, b], [a, b]), false);
		assert.equal(isAppend([], [a]), true);
	});

	it("compares sets by their members", () => {
		assert.equal(sameSet(new Set([a, b]), new Set([b, a])), true);
		assert.equal(sameSet(new Set([a]), new Set([b])), false);
		assert.equal(sameSet(new Set([a]), new Set([a, b])), false);
	});
});

describe("the pixel eraser, cut as it goes", () => {
	// a long horizontal stroke, an eraser (radius 5) crossing it at x = 50, and a far-off stroke it never meets
	const stroke: SketchStroke = { size: 4, points: Array.from({ length: 21 }, (_, i) => [i * 10, 0, 0.5]).flat() };
	const far = line(0, 500, 100, 500);

	it("cuts nothing until the eraser reaches a stroke", () => {
		const cut = newCut();
		const changed = advanceCut(cut, [50, 200, 0.5, 50, 100, 0.5], 5, [[stroke, far]]);
		assert.deepEqual(changed, []);
		assert.equal(cut.pieces.size, 0);
	});

	it("splits the stroke it crosses, and leaves the far one alone", () => {
		const cut = newCut();
		const changed = advanceCut(cut, [50, 20, 0.5, 50, -20, 0.5], 5, [[stroke, far]]);
		assert.deepEqual(changed, [stroke]);
		const pieces = cut.pieces.get(stroke);
		assert.ok(pieces && pieces.length === 2);
		assert.equal(cut.pieces.has(far), false);
	});

	it("matches cutting the whole path at once, sample by sample", () => {
		const path = [50, 20, 0.5, 50, 5, 0.5, 50, -20, 0.5, 120, -20, 0.5, 120, 20, 0.5];
		const cut = newCut();
		// the path arrives in three steps, as the frames of a gesture do
		for (const n of [2, 3, 5]) advanceCut(cut, path.slice(0, n * 3), 5, [[stroke]]);
		const whole = sketchStrokeCut(stroke, [50, 20, 50, 5, 50, -20, 120, -20, 120, 20], 5);
		const stepped = cut.pieces.get(stroke);
		assert.ok(whole && stepped);
		assert.equal(stepped.length, whole.length);
		// every piece starts and ends within a pixel of where the one-shot cut put it
		stepped.forEach((piece, i) => {
			const w = whole[i]!;
			near(piece.points[0]!, w.points[0]!, 1.5);
			near(piece.points[piece.points.length - 3]!, w.points[w.points.length - 3]!, 1.5);
		});
	});

	it("does nothing when no sample is new", () => {
		const cut = newCut();
		const path = [50, 20, 0.5, 50, -20, 0.5];
		advanceCut(cut, path, 5, [[stroke]]);
		assert.deepEqual(advanceCut(cut, path, 5, [[stroke]]), []);
	});
});
