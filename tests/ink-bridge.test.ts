import assert from "node:assert/strict";
import test from "node:test";
import { decodeShellLine, encodeInkOp, eraseHits, isErasedExactly, parseNativeStrokes, strokesJson } from "../src/core/ink-bridge.ts";
import { SketchPayloadError } from "../src/core/sketch.ts";

test("encodeInkOp: one short line per operation, numbers rounded to 2 decimals", () => {
	assert.equal(encodeInkOp({ op: "open", inkKey: "call_abc-1", rect: { x: 0, y: 120.456, w: 411, h: 640 } }), "open call_abc-1 0 120.46 411 640");
	assert.equal(encodeInkOp({ op: "holes", rects: [{ x: 8, y: 8, w: 300, h: 200 }, { x: 10.5, y: 250, w: 100, h: 40 }] }), "holes 8,8,300,200 10.5,250,100,40");
	assert.equal(encodeInkOp({ op: "holes", rects: [] }), "holes");
	assert.equal(encodeInkOp({ op: "tool", tool: "eraser" }), "tool eraser");
	assert.equal(encodeInkOp({ op: "eraser", mode: "stroke", radius: 20 }), "eraser stroke 20");
	assert.equal(encodeInkOp({ op: "eraser", mode: "pixel", radius: 10.456 }), "eraser pixel 10.46");
	for (const radius of [0, 0.5, 201, Number.NaN]) assert.throws(() => encodeInkOp({ op: "eraser", mode: "stroke", radius }), String(radius));
	assert.equal(encodeInkOp({ op: "brush", color: "#dc2626", size: 8 }), "brush #dc2626 8");
	assert.throws(() => encodeInkOp({ op: "brush", color: "red", size: 4 }));
	assert.throws(() => encodeInkOp({ op: "brush", color: "#dc2626", size: 0 }));
	assert.equal(encodeInkOp({ op: "sheet", tone: "dark" }), "sheet dark");
	assert.equal(encodeInkOp({ op: "sheet", tone: "light" }), "sheet light");
	assert.equal(encodeInkOp({ op: "view", zoom: 2.5, x: -300.456, y: 120 }), "view 2.5000 -300.46 120");
	assert.equal(encodeInkOp({ op: "view", zoom: 0.5, x: 0, y: 0 }), "view 0.5000 0 0");
	assert.equal(encodeInkOp({ op: "view", zoom: 3, x: 0, y: 0 }), "view 3.0000 0 0");
	for (const zoom of [0.1, 0.45, 3.5, 8, Number.NaN]) assert.throws(() => encodeInkOp({ op: "view", zoom, x: 0, y: 0 }), String(zoom));
	assert.throws(() => encodeInkOp({ op: "view", zoom: 1, x: Number.POSITIVE_INFINITY, y: 0 }));
	for (const op of ["ack", "close"] as const) assert.equal(encodeInkOp({ op }), op);
});

test("encodeInkOp: the store's strokes ride as JSON the shell parses (strokes and kept)", () => {
	const strokes = [{ size: 4, points: [1, 2, 0.5] }, { size: 4, color: "#2563eb" as const, points: [3, 4, 1, 5, 6, 0.2] }];
	assert.equal(encodeInkOp({ op: "strokes", strokes }), `strokes ${JSON.stringify(strokes)}`);
	assert.equal(encodeInkOp({ op: "kept", strokes: [] }), "kept []");
});

test("encodeInkOp refuses an ink key the shell would not parse", () => {
	assert.throws(() => encodeInkOp({ op: "open", inkKey: "has space", rect: { x: 0, y: 0, w: 1, h: 1 } }));
	assert.throws(() => encodeInkOp({ op: "open", inkKey: "", rect: { x: 0, y: 0, w: 1, h: 1 } }));
	assert.throws(() => encodeInkOp({ op: "open", inkKey: "x".repeat(81), rect: { x: 0, y: 0, w: 1, h: 1 } }));
});

test("parseNativeStrokes: strokes from the shell are validated like a web sketch", () => {
	const ok = JSON.stringify([
		{ size: 3, points: [10, 20, 0.5, 11, 21, 0.6] },
		{ size: 2.5, color: "#ff0000", points: [1, 2, 1, 3, 4, 0] },
	]);
	const strokes = parseNativeStrokes(ok);
	assert.equal(strokes.length, 2);
	assert.equal(strokes[1]!.color, "#ff0000");
});

test("parseNativeStrokes: bad strokes are refused with the contract's own error", () => {
	assert.throws(() => parseNativeStrokes("not json"), /not JSON/);
	assert.throws(() => parseNativeStrokes("[]"), SketchPayloadError, "no strokes");
	assert.throws(() => parseNativeStrokes(JSON.stringify([{ size: 3, points: [1, 2] }])), SketchPayloadError, "not triples");
	assert.throws(() => parseNativeStrokes(JSON.stringify([{ size: 3, points: [1, 2, 7] }])), SketchPayloadError, "pressure out of range");
	assert.throws(() => parseNativeStrokes(JSON.stringify([{ size: 3, color: "red", points: [1, 2, 0.5] }])), SketchPayloadError, "colour");
	assert.throws(() => parseNativeStrokes(JSON.stringify({ not: "an array" })), SketchPayloadError);
});

test("decodeShellLine: what the shell says", () => {
	assert.deepEqual(decodeShellLine('stroke [{"size":4,"points":[1,2,0.5,3,4,0.5]}]'), { kind: "stroke", stroke: { size: 4, points: [1, 2, 0.5, 3, 4, 0.5] } });
	assert.deepEqual(decodeShellLine("erase 1,2,3.5,4"), { kind: "erase", points: [1, 2, 3.5, 4] });
	assert.deepEqual(decodeShellLine("gesture -12.5 3 1.5 200 310.25"), { kind: "gesture", dx: -12.5, dy: 3, scale: 1.5, fx: 200, fy: 310.25 });
	assert.deepEqual(decodeShellLine("penseen"), { kind: "penseen" });
	assert.deepEqual(decodeShellLine("fallback no surface available"), { kind: "fallback", reason: "no surface available" });
	assert.deepEqual(decodeShellLine("fallback"), { kind: "fallback", reason: "unavailable" });
});

test("decodeShellLine: anything else is ignored, never thrown", () => {
	for (const bad of ["", "nonsense", "stroke", "stroke nope", "stroke []", 'stroke [{"size":4,"points":[1,2]}]', "erase", "erase 1", "erase 1,2,3", "erase a,b", "pan 5", "gesture", "gesture 1 2 3", "gesture 1 2 0 3 4", "gesture 1 2 -1 3 4", "gesture a b c d e", "gesture 1 2 NaN 3 4", "penseen now"]) {
		assert.equal(decodeShellLine(bad), null, bad);
	}
});

test("caps: the page says it understands `erased`", () => {
	assert.equal(encodeInkOp({ op: "caps" }), "caps hits");
});

test("decodeShellLine: erased <count> [indexes] — the stroke eraser's hits, found by the shell", () => {
	assert.deepEqual(decodeShellLine("erased 5 0,3,4"), { kind: "erased", count: 5, indices: [0, 3, 4] });
	assert.deepEqual(decodeShellLine("erased 5 2"), { kind: "erased", count: 5, indices: [2] });
	assert.deepEqual(decodeShellLine("erased 5"), { kind: "erased", count: 5, indices: [] }, "nothing was hit");
	assert.deepEqual(decodeShellLine("erased 0"), { kind: "erased", count: 0, indices: [] });
	for (const bad of ["erased", "erased x", "erased -1", "erased 1.5", "erased 5 5", "erased 5 -1", "erased 5 1,1", "erased 5 a,b", "erased 5 1,2 extra", "erased 5 1,,2", "erased  "]) {
		assert.equal(decodeShellLine(bad), null, bad);
	}
});

test("isErasedExactly: only an erase of exactly those strokes, the rest untouched, lets the page answer with an ack", () => {
	const [a, b, c, d] = [0, 1, 2, 3].map((n) => ({ size: 4, points: [n, n, 0.5] }));
	assert.equal(isErasedExactly([a!, b!, c!, d!], [a!, c!], [1, 3]), true);
	assert.equal(isErasedExactly([a!, b!, c!, d!], [a!, c!, d!], [1]), true);
	assert.equal(isErasedExactly([a!, b!, c!, d!], [a!, b!, c!, d!], []), false, "nothing removed is not an erase");
	assert.equal(isErasedExactly([a!, b!, c!, d!], [a!, c!], [1]), false, "the page removed more than the shell did");
	assert.equal(isErasedExactly([a!, b!, c!, d!], [a!, b!, d!], [1, 2]), false, "the page kept one the shell dropped");
	assert.equal(isErasedExactly([a!, b!, c!, d!], [a!, { ...c! }, d!], [1]), false, "a survivor was replaced by a copy");
	assert.equal(isErasedExactly([a!, b!, c!, d!], [c!, a!], [1, 3]), false, "survivors out of order");
	assert.equal(isErasedExactly([a!, b!], [a!], [1, 2]), false, "an index past the working strokes names sent ink: pushed whole, never just acknowledged");
});

test("eraseHits: any point of the gesture within reach of a stroke, each stroke once", () => {
	const line = { size: 4, points: [0, 0, 0.5, 100, 0, 0.5] };
	const far = { size: 4, points: [0, 200, 0.5, 100, 200, 0.5] };
	assert.deepEqual(eraseHits([line, far], [50, 5, 60, 6], 10), [0]);
	assert.deepEqual(eraseHits([line, far], [50, 5, 50, 200], 10), [0, 1]);
	assert.deepEqual(eraseHits([line, far], [500, 500], 10), []);
	assert.deepEqual(eraseHits([line], [], 10), []);
});

test("strokesJson: the same text JSON.stringify makes, stroke by stroke, and again from what it kept", () => {
	const a = { size: 4, points: [1, 2, 0.5, 3, 4, 0.5] };
	const b = { size: 2.5, color: "#2563eb" as const, fresh: false, points: [3, 4, 1] };
	const c = { size: 4, points: [] as number[] };
	for (const list of [[], [a], [a, b], [b, a, c], [c]]) {
		assert.equal(strokesJson(list), JSON.stringify(list));
		assert.equal(strokesJson(list), JSON.stringify(list), "the second time comes from the kept texts");
	}
	// a stroke whose points changed length is written again, not served stale
	const grown = { size: 4, points: [1, 2, 0.5] };
	assert.equal(strokesJson([grown]), JSON.stringify([grown]));
	grown.points.push(3, 4, 0.5);
	assert.equal(strokesJson([grown]), JSON.stringify([grown]));
});
