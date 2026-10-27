import assert from "node:assert/strict";
import test from "node:test";
import { encodeInkOp, parseNativeStrokes } from "../src/core/ink-bridge.ts";
import { SketchPayloadError } from "../src/core/sketch.ts";

test("encodeInkOp: one short line per operation, numbers rounded to 2 decimals", () => {
	assert.equal(encodeInkOp({ op: "open", inkKey: "call_abc-1", rect: { x: 0, y: 120.456, w: 411, h: 640 } }), "open call_abc-1 0 120.46 411 640");
	assert.equal(encodeInkOp({ op: "holes", rects: [{ x: 8, y: 8, w: 300, h: 200 }, { x: 10.5, y: 250, w: 100, h: 40 }] }), "holes 8,8,300,200 10.5,250,100,40");
	assert.equal(encodeInkOp({ op: "holes", rects: [] }), "holes");
	assert.equal(encodeInkOp({ op: "tool", tool: "eraser" }), "tool eraser");
	for (const op of ["undo", "redo", "clear", "close", "export"] as const) assert.equal(encodeInkOp({ op }), op);
});

test("encodeInkOp refuses an ink key the shell would not parse", () => {
	assert.throws(() => encodeInkOp({ op: "open", inkKey: "has space", rect: { x: 0, y: 0, w: 1, h: 1 } }));
	assert.throws(() => encodeInkOp({ op: "open", inkKey: "", rect: { x: 0, y: 0, w: 1, h: 1 } }));
	assert.throws(() => encodeInkOp({ op: "open", inkKey: "x".repeat(81), rect: { x: 0, y: 0, w: 1, h: 1 } }));
});

test("parseNativeStrokes: the shell's export is validated like a web sketch", () => {
	const ok = JSON.stringify([
		{ size: 3, points: [10, 20, 0.5, 11, 21, 0.6] },
		{ size: 2.5, color: "#ff0000", points: [1, 2, 1, 3, 4, 0] },
	]);
	const strokes = parseNativeStrokes(ok);
	assert.equal(strokes.length, 2);
	assert.equal(strokes[1]!.color, "#ff0000");
});

test("parseNativeStrokes: bad exports are refused with the contract's own error", () => {
	assert.throws(() => parseNativeStrokes("not json"), /not JSON/);
	assert.throws(() => parseNativeStrokes("[]"), SketchPayloadError, "no strokes");
	assert.throws(() => parseNativeStrokes(JSON.stringify([{ size: 3, points: [1, 2] }])), SketchPayloadError, "not triples");
	assert.throws(() => parseNativeStrokes(JSON.stringify([{ size: 3, points: [1, 2, 7] }])), SketchPayloadError, "pressure out of range");
	assert.throws(() => parseNativeStrokes(JSON.stringify([{ size: 3, color: "red", points: [1, 2, 0.5] }])), SketchPayloadError, "colour");
	assert.throws(() => parseNativeStrokes(JSON.stringify({ not: "an array" })), SketchPayloadError);
});
