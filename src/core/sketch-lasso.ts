import type { SketchStroke } from "./contracts/sketch.ts";

/**
 * The lasso's pure part (owner plan, 2026-11-19): which strokes a loop around ink selects, and how a selection moves, scales,
 * turns, takes another colour or width, or is copied. A stroke is never edited in place (ink-memory's history and the native layer's
 * caches hold the objects), so every change makes new stroke objects.
 */

/** x' = a x + c y + e, y' = b x + d y + f (the canvas matrix order). */
export interface Affine {
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const translation = (dx: number, dy: number): Affine => ({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });

/** Scale by `k` about a point. */
export const scaleAbout = (cx: number, cy: number, k: number): Affine => ({ a: k, b: 0, c: 0, d: k, e: cx - k * cx, f: cy - k * cy });

/** Turn by `theta` radians (clockwise on screen, y down) about a point. */
export function rotateAbout(cx: number, cy: number, theta: number): Affine {
	const cos = Math.cos(theta), sin = Math.sin(theta);
	return { a: cos, b: sin, c: -sin, d: cos, e: cx - cos * cx + sin * cy, f: cy - sin * cx - cos * cy };
}

/** The matrix that does `first`, then `second`. */
export function compose(second: Affine, first: Affine): Affine {
	return {
		a: second.a * first.a + second.c * first.b,
		b: second.b * first.a + second.d * first.b,
		c: second.a * first.c + second.c * first.d,
		d: second.b * first.c + second.d * first.d,
		e: second.a * first.e + second.c * first.f + second.e,
		f: second.b * first.e + second.d * first.f + second.f,
	};
}

export const applyAffine = (m: Affine, x: number, y: number): [number, number] => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];

/** How much the matrix scales lengths (the square root of its area factor). */
export const affineScale = (m: Affine): number => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));

export const isIdentity = (m: Affine): boolean => m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

const MIN_SIZE = 0.5;
const MAX_SIZE = 64;
const clampSize = (n: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, n));
const q2 = (n: number) => Math.round(n * 100) / 100;

/** A stroke moved through `m`: its width scales with the matrix (kept inside what the validator accepts). Keeps id, seg and colour; it is
 *  edited ink now, so a "sent" marker is dropped. */
export function transformStroke(s: SketchStroke, m: Affine): SketchStroke {
	const points = new Array<number>(s.points.length);
	for (let k = 0; k < s.points.length; k += 3) {
		const [x, y] = applyAffine(m, s.points[k]!, s.points[k + 1]!);
		points[k] = q2(x);
		points[k + 1] = q2(y);
		points[k + 2] = s.points[k + 2]!;
	}
	const out: SketchStroke = { size: q2(clampSize(s.size * affineScale(m))), points };
	if (s.color !== undefined) out.color = s.color;
	if (s.id !== undefined) out.id = s.id;
	if (s.seg !== undefined) out.seg = s.seg;
	return out;
}

/** A stroke with another colour and/or width (an edit: a "sent" marker is dropped). */
export function restyleStroke(s: SketchStroke, style: { color?: string; size?: number }): SketchStroke {
	const out: SketchStroke = { size: style.size === undefined ? s.size : clampSize(style.size), points: s.points };
	const color = style.color ?? s.color;
	if (color !== undefined) out.color = color;
	if (s.id !== undefined) out.id = s.id;
	if (s.seg !== undefined) out.seg = s.seg;
	return out;
}

/** Copies of strokes moved by (dx, dy), as NEW ink: no id or segment (a lecture note stamps them where they are pasted). */
export function pasteCopies(strokes: readonly SketchStroke[], dx: number, dy: number): SketchStroke[] {
	return strokes.map((s) => {
		const { id: _id, seg: _seg, ...moved } = transformStroke(s, translation(dx, dy));
		return moved;
	});
}

export interface Rect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

export function boundsOf(strokes: readonly SketchStroke[]): Rect | null {
	let r: Rect | null = null;
	for (const s of strokes) {
		for (let k = 0; k + 1 < s.points.length; k += 3) {
			const x = s.points[k]!, y = s.points[k + 1]!;
			if (r === null) r = { x0: x, y0: y, x1: x, y1: y };
			else {
				if (x < r.x0) r.x0 = x;
				if (x > r.x1) r.x1 = x;
				if (y < r.y0) r.y0 = y;
				if (y > r.y1) r.y1 = y;
			}
		}
	}
	return r;
}

/** Even-odd test of a point against a polygon (flat [x, y, …]). */
export function pointInPolygon(x: number, y: number, poly: readonly number[]): boolean {
	let inside = false;
	const n = poly.length / 2;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = poly[2 * i]!, yi = poly[2 * i + 1]!, xj = poly[2 * j]!, yj = poly[2 * j + 1]!;
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** A stroke is selected when at least this share of its points lie inside the loop (owner plan: the author's choice, tune by hand). */
export const LASSO_MIN_SHARE = 0.5;

/** The strokes a closed loop (flat [x, y, …], world units) selects, as indexes into `strokes`. A loop of fewer than three points selects nothing. */
export function lassoSelect(strokes: readonly SketchStroke[], loop: readonly number[]): number[] {
	if (loop.length < 6) return [];
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (let k = 0; k + 1 < loop.length; k += 2) {
		x0 = Math.min(x0, loop[k]!), x1 = Math.max(x1, loop[k]!);
		y0 = Math.min(y0, loop[k + 1]!), y1 = Math.max(y1, loop[k + 1]!);
	}
	const hits: number[] = [];
	strokes.forEach((s, i) => {
		let inside = 0, total = 0;
		for (let k = 0; k + 1 < s.points.length; k += 3) {
			const x = s.points[k]!, y = s.points[k + 1]!;
			total++;
			if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && pointInPolygon(x, y, loop)) inside++;
		}
		if (total > 0 && inside / total >= LASSO_MIN_SHARE) hits.push(i);
	});
	return hits;
}
