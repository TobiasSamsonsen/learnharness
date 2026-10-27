/**
 * The native-ink bridge's wire format (Android plan M10, docs/android/m10-plan.md). The shell exposes
 * `window.lhAndroid` (a WebMessageListener, android/app InkBridge.kt): the page sends one short text line per
 * operation with `lhAndroid.postMessage(line)`, and the shell answers through `lhAndroid.onmessage` / the
 * `message` event. Everything here is pure; `InkWire.kt` parses and writes the same lines.
 *
 * The web store (components/sketch/ink-memory.ts) owns the strokes (owner decision B, 2026-10-27): the shell only
 * draws and reports, so undo, redo, clear, persistence and the kept page need no native counterpart.
 *
 * web -> shell
 *   open <inkKey> <x> <y> <w> <h>     the canvas rectangle in CSS px of the viewport; the native layer sits there
 *   holes <x,y,w,h> …                 web UI over the canvas (the floating box): touches there stay with the page
 *   tool pen|eraser                   the toolbar's tool
 *   strokes <json>                    the finished strokes of the page being written (replaces what the shell has)
 *   kept <json>                       strokes already sent to the tutor (drawn faint)
 *   scroll <y>                        the canvas' scroll offset in CSS px
 *   ack                               the stroke the shell just reported is in the store: keep it as drawn
 *   close
 * shell -> web
 *   stroke <json>                     one finished stroke (an array of one SketchStroke), canvas-relative page px
 *   erase <x,y,x,y,…>                 an eraser gesture; the web decides which strokes it hit
 *   pan <dy>                          two fingers scrolled the canvas by this many CSS px (positive = further down)
 *   penseen                           a real stylus has been used (touch now scrolls)
 *   fallback <reason>                 the native layer cannot be shown: keep the web canvas
 *
 * A native sketch is the same `SketchPayload` the web canvas sends, with `producer: "android-ink"`. No server change.
 */

import type { SketchStroke } from "./contracts/sketch.ts";
import { parseSketchPayload, sketchStrokeHit } from "./sketch.ts";

export interface NativeInkRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type NativeInkTool = "pen" | "eraser";

export type NativeInkOp =
	| { op: "open"; inkKey: string; rect: NativeInkRect }
	| { op: "holes"; rects: NativeInkRect[] }
	| { op: "tool"; tool: NativeInkTool }
	| { op: "strokes" | "kept"; strokes: readonly SketchStroke[] }
	| { op: "scroll"; y: number }
	| { op: "ack" | "close" };

const KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;

const num = (n: number): string => String(Math.round(n * 100) / 100);
const rectText = (r: NativeInkRect): string => `${num(r.x)},${num(r.y)},${num(r.w)},${num(r.h)}`;

/** One operation as the line the shell parses. Throws on a key the shell would refuse. */
export function encodeInkOp(op: NativeInkOp): string {
	switch (op.op) {
		case "open":
			if (!KEY_RE.test(op.inkKey)) throw new Error("ink key must be 1-80 letters, digits, _ or -");
			return `open ${op.inkKey} ${num(op.rect.x)} ${num(op.rect.y)} ${num(op.rect.w)} ${num(op.rect.h)}`;
		case "holes":
			return ["holes", ...op.rects.map(rectText)].join(" ");
		case "tool":
			return `tool ${op.tool}`;
		case "strokes":
		case "kept":
			return `${op.op} ${JSON.stringify(op.strokes)}`;
		case "scroll":
			return `scroll ${num(op.y)}`;
		default:
			return op.op;
	}
}

/** Strokes from the shell, validated by the same rules as a web sketch (sizes, colours, [x, y, pressure] triples,
 *  point counts). Throws SketchPayloadError on anything the server would refuse. */
export function parseNativeStrokes(text: string): SketchStroke[] {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("the native ink export is not JSON");
	}
	return parseSketchPayload({ id: "sk_native_export", producer: "android-ink", strokes: value }).strokes;
}

export type ShellEvent =
	| { kind: "stroke"; stroke: SketchStroke }
	| { kind: "erase"; points: number[] }
	| { kind: "pan"; dy: number }
	| { kind: "penseen" }
	| { kind: "fallback"; reason: string };

/** One line from the shell, or null when it is not one the page understands (never throws). */
export function decodeShellLine(line: string): ShellEvent | null {
	const text = line.trim();
	const verb = text.split(" ", 1)[0];
	const rest = text.slice(verb!.length).trim();
	try {
		switch (verb) {
			case "stroke": {
				const strokes = parseNativeStrokes(rest);
				return strokes.length === 1 ? { kind: "stroke", stroke: strokes[0]! } : null;
			}
			case "erase": {
				const points = rest.split(",").map(Number);
				return points.length >= 2 && points.length % 2 === 0 && points.every(Number.isFinite) ? { kind: "erase", points } : null;
			}
			case "pan": {
				const dy = Number(rest);
				return rest !== "" && Number.isFinite(dy) ? { kind: "pan", dy } : null;
			}
			case "penseen":
				return rest === "" ? { kind: "penseen" } : null;
			case "fallback":
				return { kind: "fallback", reason: rest || "unavailable" };
			default:
				return null;
		}
	} catch {
		return null;
	}
}

/** The indexes of the strokes an eraser gesture touched: any point of the gesture within `radius` of a stroke. */
export function eraseHits(strokes: readonly SketchStroke[], points: readonly number[], radius: number): number[] {
	const hits: number[] = [];
	strokes.forEach((stroke, index) => {
		for (let k = 0; k + 1 < points.length; k += 2) {
			if (sketchStrokeHit(stroke, points[k]!, points[k + 1]!, radius)) {
				hits.push(index);
				return;
			}
		}
	});
	return hits;
}
