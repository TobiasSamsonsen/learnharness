/**
 * The lasso (owner plan, 2026-11-19): what a loop selects, how a selection transforms and restyles (new objects, ids kept), the
 * two history operations it adds (transform, paste: apply, revert, validate), and the note's stamping of pasted strokes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	affineScale,
	applyAffine,
	boundsOf,
	compose,
	IDENTITY,
	isIdentity,
	lassoSelect,
	pasteCopies,
	pointInPolygon,
	restyleStroke,
	rotateAbout,
	scaleAbout,
	transformStroke,
	translation,
} from "../src/core/sketch-lasso.ts";
import { applyOp, revertOp, validOp, type InkOp } from "../components/sketch/ink-memory.ts";
import type { SketchStroke } from "../src/core/contracts/sketch.ts";

const line = (x0: number, y0: number, x1: number, y1: number, extra: Partial<SketchStroke> = {}): SketchStroke => ({ size: 4, points: [x0, y0, 0.5, (x0 + x1) / 2, (y0 + y1) / 2, 0.5, x1, y1, 0.5], ...extra });
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ~ ${b}`);

describe("selecting with a loop", () => {
	const square = [0, 0, 100, 0, 100, 100, 0, 100];

	it("tells inside from outside, also for a loop that is not convex", () => {
		assert.equal(pointInPolygon(50, 50, square), true);
		assert.equal(pointInPolygon(150, 50, square), false);
		const arrow = [0, 0, 100, 50, 0, 100, 40, 50]; // a notch on the left
		assert.equal(pointInPolygon(20, 50, arrow), false, "in the notch");
		assert.equal(pointInPolygon(70, 50, arrow), true);
	});

	it("selects the strokes that are mostly inside (half of their points), by index", () => {
		const strokes = [line(10, 10, 90, 90), line(200, 200, 260, 260), line(40, 50, 140, 50) /* 2 of 3 points inside */, line(80, 50, 200, 50) /* 1 of 3 */];
		assert.deepEqual(lassoSelect(strokes, square), [0, 2]);
		assert.deepEqual(lassoSelect(strokes, [0, 0, 100, 0]), [], "a loop of fewer than three points selects nothing");
	});
});

describe("transforming a selection", () => {
	it("composes: first, then second; scaling about a point leaves the point where it is", () => {
		const m = compose(translation(5, 0), scaleAbout(10, 10, 2));
		const [x, y] = applyAffine(m, 10, 10);
		near(x, 15);
		near(y, 10);
		assert.ok(isIdentity(IDENTITY));
		assert.equal(isIdentity(translation(1, 0)), false);
		near(affineScale(scaleAbout(0, 0, 3)), 3);
		near(affineScale(rotateAbout(5, 5, 1)), 1);
	});

	it("turns a quarter about the centre (clockwise on screen, y down)", () => {
		const [x, y] = applyAffine(rotateAbout(0, 0, Math.PI / 2), 10, 0);
		near(x, 0);
		near(y, 10);
	});

	it("a moved stroke is a new object with the same id, segment and colour, and no 'sent' marker; its width scales with the matrix", () => {
		const s: SketchStroke = { size: 4, color: "#dc2626", id: "kabc", seg: "g12345678", fresh: false, points: [0, 0, 0.5, 10, 10, 0.5] };
		const moved = transformStroke(s, translation(5, 7));
		assert.notEqual(moved, s);
		assert.deepEqual(moved, { size: 4, color: "#dc2626", id: "kabc", seg: "g12345678", points: [5, 7, 0.5, 15, 17, 0.5] });
		assert.equal(s.points[0], 0, "the original is untouched");
		assert.equal(transformStroke(s, scaleAbout(0, 0, 2)).size, 8);
		assert.equal(transformStroke(s, scaleAbout(0, 0, 100)).size, 64, "kept inside what the validator accepts");
		assert.equal(transformStroke(s, scaleAbout(0, 0, 0.01)).size, 0.5);
	});

	it("restyling changes only what is named; copies are new ink without id or segment", () => {
		const s: SketchStroke = { size: 4, id: "kabc", seg: "g12345678", points: [0, 0, 0.5, 10, 10, 0.5] };
		assert.deepEqual(restyleStroke(s, { color: "#2563eb" }), { size: 4, color: "#2563eb", id: "kabc", seg: "g12345678", points: s.points });
		assert.equal(restyleStroke(s, { size: 8 }).size, 8);
		const [copy] = pasteCopies([s], 20, 20);
		assert.deepEqual(copy, { size: 4, points: [20, 20, 0.5, 30, 30, 0.5] });
		assert.deepEqual(boundsOf([s]), { x0: 0, y0: 0, x1: 10, y1: 10 });
		assert.equal(boundsOf([]), null);
	});
});

describe("the history operations of the lasso", () => {
	const a = line(0, 0, 10, 10, { id: "ka" }), b = line(20, 20, 30, 30, { id: "kb" }), c = line(40, 40, 50, 50, { id: "kc" });

	it("a transform replaces strokes in place and reverts to the originals", () => {
		const b2 = transformStroke(b, translation(100, 0)), c2 = transformStroke(c, translation(100, 0));
		const op: InkOp = { kind: "transform", changes: [{ index: 1, before: b, after: b2 }, { index: 2, before: c, after: c2 }] };
		const done = applyOp([a, b, c], op);
		assert.deepEqual(done, [a, b2, c2]);
		assert.deepEqual(revertOp(done, op), [a, b, c]);
		assert.equal(revertOp(done, op)[1], b, "the very objects come back (the history is by identity)");
	});

	it("a paste appends and reverts by identity, even with later strokes added", () => {
		const added = pasteCopies([a], 5, 5);
		const op: InkOp = { kind: "paste", added };
		const done = applyOp([a, b], op);
		assert.equal(done.length, 3);
		assert.deepEqual(revertOp([...done, c], op), [a, b, c]);
	});

	it("both kinds are valid history entries; a damaged one is not", () => {
		assert.equal(validOp({ kind: "transform", changes: [{ index: 0, before: a, after: b }] }), true);
		assert.equal(validOp({ kind: "paste", added: [a] }), true);
		assert.equal(validOp({ kind: "transform", changes: [{ index: "0", before: a, after: b }] }), false);
		assert.equal(validOp({ kind: "paste", added: [{ nope: 1 }] }), false);
	});
});
