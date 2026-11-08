import type { SketchStroke } from "@/src/core";
import { dist, type Pt } from "./straight-line.ts";

/**
 * The angle guide for straightened lines: while a held line is drawn from a point close to another straight line, the
 * smaller angle between the two is shown (an arc and a whole-degree label) until the pen lifts. Pure geometry, so the
 * rules are tested without a screen; the canvas calls into it. The native layer mirrors this in InkAngle.kt (same
 * numbers on both).
 *
 * A straightened line is stored as an ordinary stroke (no flag): collinear points, evenly spaced (`linePoints`), so a
 * stored stroke counts as a straight line when it looks like one ([straightSegment]).
 */

/** The new line must start this close (screen px) to the other line for the angle to show. */
export const NEAR_PX = 16;
/** The arc's radius is this share of the new line's length (screen px), kept between the two bounds below. */
export const ARC_RATIO = 0.25;
export const ARC_MIN_PX = 16;
export const ARC_MAX_PX = 80;
/** Below this angle (degrees) the lines are parallel for our purposes and nothing shows. */
export const MIN_ANGLE_DEG = 1;
/** A stored stroke is a straight line when every point lies within this distance (world px) of the line through its ends. */
export const STRAIGHT_TOL = 0.5;
/** ... and the gaps between consecutive points differ from their mean by at most this share (`linePoints` writes equal ones). */
export const GAP_TOL = 0.1;
/** A line shorter than this (world px, one `linePoints` step) has no direction worth measuring against. */
export const MIN_SEGMENT = 6;

/** A straight line already on the page: its two ends, world px. */
export interface Segment {
	a: Pt;
	b: Pt;
}

/** What the guide draws, with the angles in radians as the canvases take them (clockwise from +x, y down). */
export interface LineAngle {
	/** Where the new line meets the other one (world px). */
	vertex: Pt;
	/** Direction of the new line from the vertex. */
	from: number;
	/** Signed sweep from the new line to the other line's nearer ray; its size is at most a right angle. */
	sweep: number;
	/** The angle in whole degrees, 1..90. */
	degrees: number;
	/** Arc radius in screen px. */
	radiusPx: number;
}

/** The ends of the stroke when it is a straight line as `linePoints` writes it (collinear, evenly spaced), else null. */
export function straightSegment(points: readonly number[]): Segment | null {
	const n = Math.floor(points.length / 3);
	if (n < 2) return null;
	const a = { x: points[0]!, y: points[1]! };
	const b = { x: points[(n - 1) * 3]!, y: points[(n - 1) * 3 + 1]! };
	const len = dist(a, b);
	if (len < MIN_SEGMENT) return null;
	const ux = (b.x - a.x) / len;
	const uy = (b.y - a.y) / len;
	const mean = len / (n - 1);
	let prev = a;
	for (let i = 1; i < n; i++) {
		const p = { x: points[i * 3]!, y: points[i * 3 + 1]! };
		if (Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux) > STRAIGHT_TOL) return null;
		if (Math.abs(dist(prev, p) - mean) > mean * GAP_TOL) return null;
		prev = p;
	}
	return { a, b };
}

/** The straight lines among the strokes. */
export function straightSegments(strokes: readonly Pick<SketchStroke, "points">[]): Segment[] {
	const out: Segment[] = [];
	for (const s of strokes) {
		const seg = straightSegment(s.points);
		if (seg) out.push(seg);
	}
	return out;
}

/** The point of the segment closest to `p`. */
export function closestPoint(p: Pt, seg: Segment): Pt {
	const dx = seg.b.x - seg.a.x;
	const dy = seg.b.y - seg.a.y;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - seg.a.x) * dx + (p.y - seg.a.y) * dy) / len2));
	return { x: seg.a.x + dx * t, y: seg.a.y + dy * t };
}

/**
 * The guide for a line drawn from `start` towards `end` (world px) at `zoom` (screen px per world px), or null when no
 * straight line is within NEAR_PX of `start` or the two are parallel. The nearest line wins; the vertex is the point of it
 * closest to `start`; the angle is the smaller of the two the lines make.
 */
export function lineAngle(start: Pt, end: Pt, segments: readonly Segment[], zoom: number): LineAngle | null {
	const len = dist(start, end);
	if (len === 0 || zoom <= 0) return null;
	let best: { seg: Segment; at: Pt; d: number } | null = null;
	for (const seg of segments) {
		const at = closestPoint(start, seg);
		const d = dist(start, at);
		if (d * zoom <= NEAR_PX && (!best || d < best.d)) best = { seg, at, d };
	}
	if (!best) return null;
	const segLen = dist(best.seg.a, best.seg.b);
	// the other line's direction, turned to the side the new line leans towards, so the angle is the acute one
	const dx = (end.x - start.x) / len;
	const dy = (end.y - start.y) / len;
	let ux = (best.seg.b.x - best.seg.a.x) / segLen;
	let uy = (best.seg.b.y - best.seg.a.y) / segLen;
	if (dx * ux + dy * uy < 0) {
		ux = -ux;
		uy = -uy;
	}
	const sweep = Math.atan2(dx * uy - dy * ux, dx * ux + dy * uy);
	const degrees = Math.round((Math.abs(sweep) * 180) / Math.PI);
	if (Math.abs(sweep) * (180 / Math.PI) < MIN_ANGLE_DEG) return null;
	const radiusPx = Math.min(Math.max(ARC_RATIO * len * zoom, ARC_MIN_PX), ARC_MAX_PX, segLen * zoom);
	return { vertex: best.at, from: Math.atan2(dy, dx), sweep, degrees, radiusPx };
}
