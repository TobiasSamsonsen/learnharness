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
 *   eraser pixel|stroke <radius>      the eraser's mode and reach (CSS px on screen): the shell fades the strokes the
 *                                     stroke eraser is over while the gesture runs (M16)
 *   sheet light|dark                 the sheet's tone (M13): a dark sheet shows ink in lighter variants (display only)
 *   brush <#rrggbb> <size>            the pen's colour and base width in CSS px (M13): the next strokes use it
 *   strokes <json>                    the finished strokes of the page being written (replaces what the shell has). A stroke the page
 *                                     marks `"fresh":false` is SENT ink it copied into the working page (the eraser touched it): the
 *                                     shell draws it dimmed, like `kept`, so only new ink and cut pieces are in full
 *   kept <json>                       strokes already sent to the tutor (drawn faint)
 *   view <zoom> <x> <y>               the infinite canvas's view (M13c): zoom (0.5-3, the shell drops any other) and the world position of the layer's
 *                                     top-left corner; the web owns it, the shell draws and converts touch points through it
 *   ack                               the stroke the shell just reported is in the store: keep it as drawn; after an `erased`
 *                                     line, the erase is in the store: keep the strokes the shell already removed
 *   caps hits                         this page understands `erased` (sent once, with the first `open`). A shell that has not
 *                                     seen it keeps sending `erase`, and a shell that does not know `caps` ignores the line, so
 *                                     the two can be any versions apart (the page is a server bundle, the shell an APK)
 *   close
 * shell -> web
 *   stroke <json>                     one finished stroke (an array of one SketchStroke), canvas-relative page px
 *   erase <x,y,x,y,…>                 an eraser gesture; the web decides which strokes it hit (the part eraser: the shell shows a
 *                                     paper-coloured trail along the path meanwhile, until the page's cut replaces the strokes)
 *   erased <count> [i,i,…]            the stroke eraser's gesture ended (only after `caps hits`): the shell already found which
 *                                     strokes it touched while the gesture ran and removed them from what it shows. `count` is
 *                                     how many strokes it holds, `i` their indexes in that list: the working strokes first, then the
 *                                     sent ones of `kept` (the stroke eraser reaches those too: the page thaws them). The page
 *                                     applies them as they are; when its own count differs it pushes its strokes whole (it wins)
 *   gesture <dx> <dy> <scale> <fx> <fy>  two fingers moved: their midpoint travelled (dx, dy) CSS px, the distance between them
 *                                     changed by `scale` (1 = no pinch), the midpoint is now at (fx, fy) from the layer's top-left
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
	| { op: "eraser"; mode: "pixel" | "stroke"; radius: number }
	| { op: "brush"; color: string; size: number }
	| { op: "sheet"; tone: "light" | "dark" }
	| { op: "strokes" | "kept"; strokes: readonly SketchStroke[] }
	| { op: "view"; zoom: number; x: number; y: number }
	| { op: "ack" | "close" }
	| { op: "caps" };

const KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;
const BRUSH_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * `JSON.stringify(strokes)`, with each stroke's text kept: a stroke is never edited in place (a thaw, a cut or an erase makes new
 * objects), so its text is made once and every later push or save of the page joins what it already has. Undo, redo and cut push the
 * whole page each time, and writing 2900 strokes out took about 80-140 ms in the page, per push (measured on the phone, 2026-11-07).
 * The point count guards the one edit that could make a kept text stale.
 */
const strokeText = new WeakMap<SketchStroke, { len: number; text: string }>();
export function strokesJson(strokes: readonly SketchStroke[]): string {
	let out = "[";
	for (let i = 0; i < strokes.length; i++) {
		const s = strokes[i]!;
		let kept = strokeText.get(s);
		if (!kept || kept.len !== s.points.length) {
			kept = { len: s.points.length, text: JSON.stringify(s) };
			strokeText.set(s, kept);
		}
		out += i === 0 ? kept.text : "," + kept.text;
	}
	return out + "]";
}

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
		case "eraser":
		if (!(op.radius >= 1 && op.radius <= 200)) throw new Error("eraser radius must be 1-200");
		return `eraser ${op.mode === "stroke" ? "stroke" : "pixel"} ${num(op.radius)}`;
		case "sheet":
			return `sheet ${op.tone === "dark" ? "dark" : "light"}`;
		case "brush":
			if (!BRUSH_COLOR_RE.test(op.color) || !(op.size >= 0.5 && op.size <= 64)) throw new Error("brush must be #rrggbb and a size of 0.5-64");
			return `brush ${op.color} ${num(op.size)}`;
		case "strokes":
		case "kept":
			return `${op.op} ${strokesJson(op.strokes)}`;
		case "view":
			if (!(op.zoom >= 0.5 && op.zoom <= 3) || !Number.isFinite(op.x) || !Number.isFinite(op.y)) throw new Error("view needs a zoom of 0.5-3 and finite coordinates");
			return `view ${op.zoom.toFixed(4)} ${num(op.x)} ${num(op.y)}`;
		case "caps":
			return "caps hits";
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
	| { kind: "erased"; count: number; indices: number[] }
	| { kind: "gesture"; dx: number; dy: number; scale: number; fx: number; fy: number }
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
			case "erased": {
				const [countText, listText, ...extra] = rest.split(" ");
				const count = Number(countText);
				if (extra.length > 0 || countText === "" || !Number.isInteger(count) || count < 0) return null;
				// digits and single commas only: Number("") is 0, so a "1,,2" must not read as [1, 0, 2]
				if (listText !== undefined && listText !== "" && !/^\d+(,\d+)*$/.test(listText)) return null;
				const indices = listText === undefined || listText === "" ? [] : listText.split(",").map(Number);
				const valid = indices.every((i) => Number.isInteger(i) && i < count) && new Set(indices).size === indices.length;
				return valid ? { kind: "erased", count, indices } : null;
			}
			case "gesture": {
				const n = rest.split(" ").map(Number);
				const [dx, dy, scale, fx, fy] = n as [number, number, number, number, number];
				return n.length === 5 && n.every(Number.isFinite) && scale > 0 ? { kind: "gesture", dx, dy, scale, fx, fy } : null;
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

/** Did `next` come from `prev` by removing exactly the strokes at `indices` (nothing else changed, the survivors are the same
 *  objects)? Then a shell that already removed them is right and only needs an `ack`; anything else is pushed whole. */
export function isErasedExactly(prev: readonly SketchStroke[], next: readonly SketchStroke[], indices: readonly number[]): boolean {
	const gone = new Set(indices);
	const kept = prev.filter((_, i) => !gone.has(i));
	// an index past the working strokes names sent (dimmed) ink: the page thaws that page (the strokes change shape) or ignores it
	// (still loading), and either way the shell must be told the whole truth, not just acknowledged
	if ([...gone].some((i) => i >= prev.length)) return false;
	return gone.size > 0 && next.length === kept.length && kept.every((stroke, i) => next[i] === stroke);
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
