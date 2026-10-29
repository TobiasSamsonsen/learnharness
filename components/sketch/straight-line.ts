import type { SketchStroke } from "@/src/core";

/**
 * Straight lines in the sketch view (M16c, docs/android/m16-plan.md): hold the pen still at the end of a stroke and it
 * becomes a straight line (angles near a multiple of 45 degrees snap to it), and a ruler to draw along. Pure geometry, so the
 * rules are tested without a screen; the canvas, the native layer and the ruler overlay call into it.
 */

export interface Pt {
	x: number;
	y: number;
}

/** The pen must stay inside HOLD_RADIUS (screen px) for this long for the stroke to straighten. */
export const HOLD_MS = 500;
export const HOLD_RADIUS = 4;
/** A timer set for HOLD_MS may fire a hair early; the check allows for it. */
export const HOLD_GRACE_MS = 20;
/** A stroke shorter than this (screen px) is a dot or a tick, never a line to straighten. */
export const MIN_LINE_PX = 24;
/** A line this close (degrees) to a multiple of 45 snaps to it. */
export const ANGLE_SNAP_DEG = 5;
/** Spacing of the points a straight line is written with (world px): enough for the stroke outline to stay smooth. */
const LINE_STEP = 6;

export function dist(a: Pt, b: Pt): number {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

/** `to`, moved to the nearest multiple of 45 degrees about `from` when it is within `tolDeg` of one; the length is kept. */
export function snapAngle(from: Pt, to: Pt, tolDeg: number = ANGLE_SNAP_DEG): Pt {
	const len = dist(from, to);
	if (len === 0) return to;
	const deg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
	const nearest = Math.round(deg / 45) * 45;
	if (Math.abs(deg - nearest) > tolDeg) return to;
	const rad = (nearest * Math.PI) / 180;
	return { x: from.x + Math.cos(rad) * len, y: from.y + Math.sin(rad) * len };
}

/** Flat [x, y, pressure, …] from `from` to `to`, both ends included, evenly spaced. */
export function linePoints(from: Pt, to: Pt, pressure = 0.5): number[] {
	const n = Math.max(1, Math.ceil(dist(from, to) / LINE_STEP));
	const out: number[] = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		out.push(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, pressure);
	}
	return out;
}

/** The mean pressure of a stroke's points (a line has no pressure story of its own). */
function meanPressure(points: readonly number[]): number {
	let sum = 0;
	let n = 0;
	for (let i = 2; i < points.length; i += 3) {
		sum += points[i]!;
		n++;
	}
	return n > 0 ? sum / n : 0.5;
}

/** The stroke as a straight line from its first point to `end` (default: its last), the angle snapped; look and size kept. */
export function straightenStroke(stroke: SketchStroke, end?: Pt): SketchStroke {
	const p = stroke.points;
	const from = { x: p[0]!, y: p[1]! };
	const last = end ?? { x: p[p.length - 3]!, y: p[p.length - 2]! };
	const to = snapAngle(from, last);
	return { ...stroke, points: linePoints(from, to, meanPressure(p)) };
}

/** Is the pen held still? Samples are screen points with times, newest last (a still pen sends none, so `now` is when it is asked); true when the pen stayed within HOLD_RADIUS of where it is now for HOLD_MS. */
export function isHeld(samples: readonly { x: number; y: number; t: number }[], now: number): boolean {
	const last = samples[samples.length - 1];
	if (!last) return false;
	let since = last.t;
	for (let i = samples.length - 2; i >= 0; i--) {
		const s = samples[i]!;
		if (dist(s, last) > HOLD_RADIUS) break;
		since = s.t;
	}
	return now - since >= HOLD_MS - HOLD_GRACE_MS;
}

// ─── the ruler ───────────────────────────────────────────────────────────────

/** The ruler's centre line from `a` to `b`, in one coordinate space (the caller's: screen px). */
export interface Ruler {
	a: Pt;
	b: Pt;
}

/** How thick the ruler is drawn, in the same space as its points. */
export const RULER_THICKNESS = 36;
/** A stroke that starts within this far of the ruler's edge is drawn along it. */
export const RULER_NEAR = 28;
/** …and may wander this far from a straight run beside the edge. */
export const RULER_WANDER = 14;

/**
 * The stroke's two ends, snapped onto the ruler's edge, when it was drawn along it: it starts beside the edge, runs
 * the ruler's way without wandering, and is long enough to be a line. `null` means: leave the stroke as drawn.
 * `points` are in the ruler's space.
 */
export function rulerSnap(points: readonly Pt[], ruler: Ruler, thickness = RULER_THICKNESS): [Pt, Pt] | null {
	const first = points[0];
	const last = points[points.length - 1];
	if (!first || !last || points.length < 2) return null;
	const length = dist(ruler.a, ruler.b);
	if (length === 0) return null;
	const d = { x: (ruler.b.x - ruler.a.x) / length, y: (ruler.b.y - ruler.a.y) / length };
	const n = { x: -d.y, y: d.x };
	const along = (p: Pt) => (p.x - ruler.a.x) * d.x + (p.y - ruler.a.y) * d.y;
	const across = (p: Pt) => (p.x - ruler.a.x) * n.x + (p.y - ruler.a.y) * n.y;
	const s0 = across(first);
	if (Math.abs(s0) > thickness / 2 + RULER_NEAR) return null;
	const t0 = along(first);
	const t1 = along(last);
	if (Math.abs(t1 - t0) < MIN_LINE_PX) return null;
	if (t0 < -RULER_NEAR || t0 > length + RULER_NEAR) return null;
	for (const p of points) if (Math.abs(across(p) - s0) > RULER_WANDER) return null;
	const side = s0 < 0 ? -1 : 1;
	const clamp = (t: number) => Math.min(length, Math.max(0, t));
	const at = (t: number): Pt => ({
		x: ruler.a.x + d.x * clamp(t) + n.x * side * (thickness / 2),
		y: ruler.a.y + d.y * clamp(t) + n.y * side * (thickness / 2),
	});
	return [at(t0), at(t1)];
}
