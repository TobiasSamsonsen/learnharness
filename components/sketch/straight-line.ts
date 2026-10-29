import type { SketchStroke } from "@/src/core";

/**
 * Straight lines in the sketch view (M16c, docs/android/m16-plan.md): hold the pen still at the end of a stroke and it
 * becomes a straight line (angles near a multiple of 45 degrees snap to it). Pure geometry, so the rules are tested without
 * a screen; the canvas and the native layer call into it. (A ruler was built and removed again: owner, 2026-10-29, this is
 * for sketching answers, not a note app.)
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
