/**
 * The native-ink bridge's wire format (Android plan M10, docs/android/m10-plan.md Q1/Q3). The web's sketch view
 * talks to the shell's `window.lhAndroid.ink` with one short text message per operation, and the shell answers an
 * export with the strokes as JSON. Everything here is pure; the Kotlin side (`InkWire.kt`) parses the same lines.
 *
 *   open <inkKey> <x> <y> <w> <h>     show the native surface over the canvas rectangle (CSS px)
 *   holes <x,y,w,h> <x,y,w,h> …       rectangles of web UI over the surface (the floating box): touches there go to the web
 *   tool pen|eraser                   which tool the toolbar selected
 *   undo | redo | clear | close | export
 *
 * The export reply is a JSON array of `SketchStroke` (src/core/contracts/sketch.ts), so a native sketch is the same
 * `SketchPayload` the web canvas sends, with `producer: "android-ink"`. No server change.
 */

import type { SketchStroke } from "./contracts/sketch.ts";
import { parseSketchPayload } from "./sketch.ts";

export interface InkRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type InkTool = "pen" | "eraser";

export type InkOp =
	| { op: "open"; inkKey: string; rect: InkRect }
	| { op: "holes"; rects: InkRect[] }
	| { op: "tool"; tool: InkTool }
	| { op: "undo" | "redo" | "clear" | "close" | "export" };

const KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;

const num = (n: number): string => String(Math.round(n * 100) / 100);
const rectText = (r: InkRect): string => `${num(r.x)},${num(r.y)},${num(r.w)},${num(r.h)}`;

/** One operation as the line the shell parses. Throws on a key the shell would refuse. */
export function encodeInkOp(op: InkOp): string {
	switch (op.op) {
		case "open":
			if (!KEY_RE.test(op.inkKey)) throw new Error("ink key must be 1-80 letters, digits, _ or -");
			return `open ${op.inkKey} ${num(op.rect.x)} ${num(op.rect.y)} ${num(op.rect.w)} ${num(op.rect.h)}`;
		case "holes":
			return ["holes", ...op.rects.map(rectText)].join(" ");
		case "tool":
			return `tool ${op.tool}`;
		default:
			return op.op;
	}
}

/** The strokes the shell exported, validated by the same rules as a web sketch (sizes, colours, [x, y, pressure]
 *  triples, point counts). Throws SketchPayloadError on anything the server would refuse. */
export function parseNativeStrokes(text: string): SketchStroke[] {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("the native ink export is not JSON");
	}
	return parseSketchPayload({ id: "sk_native_export", producer: "android-ink", strokes: value }).strokes;
}
