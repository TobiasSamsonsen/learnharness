package dev.learnharness.android

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The angle guide for straightened lines, native half: while a held line is drawn from a point close to another straight
 * line, the smaller angle between the two is shown (an arc and a whole-degree label) until the pen lifts. Pure, so
 * `./gradlew test` covers it. Mirrors components/sketch/line-angle.ts (the web canvas does the same on its own strokes);
 * the numbers are the same on both.
 *
 * A straightened line is stored as an ordinary stroke (no flag): collinear points, evenly spaced ([InkStraight.linePoints]),
 * so a stored stroke counts as a straight line when it looks like one ([segment]).
 */
object InkAngle {
	/** The new line must start this close (screen px) to the other line. */
	const val NEAR_PX = 16.0
	/** The arc's radius is this share of the new line's length (screen px), between the two bounds. */
	const val ARC_RATIO = 0.25
	const val ARC_MIN_PX = 16.0
	const val ARC_MAX_PX = 80.0
	/** Below this angle (degrees) the lines are parallel for our purposes and nothing shows. */
	const val MIN_ANGLE_DEG = 1.0
	/** A stored stroke is a straight line when every point is within this distance (world px) of the line through its ends. */
	const val STRAIGHT_TOL = 0.5
	/** ... and the gaps between consecutive points differ from their mean by at most this share. */
	const val GAP_TOL = 0.1
	/** A line shorter than this (world px, one linePoints step) has no direction worth measuring against. */
	const val MIN_SEGMENT = 6.0

	/** A straight line already on the page: its two ends, world px. */
	class Segment(val ax: Double, val ay: Double, val bx: Double, val by: Double)

	/**
	 * What the guide draws, angles in degrees as Canvas.drawArc takes them (clockwise from 3 o'clock, y down): [from] is the
	 * new line's direction from the vertex, [sweep] the signed way to the other line's nearer ray (at most 90 in size).
	 */
	class Guide(val vx: Double, val vy: Double, val from: Double, val sweep: Double, val degrees: Int, val radiusPx: Double)

	/** The ends of the stroke (flat [x, y, pressure, …]) when it is a straight line as linePoints writes it, else null. */
	fun segment(points: FloatArray): Segment? {
		val n = points.size / 3
		if (n < 2) return null
		val ax = points[0].toDouble()
		val ay = points[1].toDouble()
		val bx = points[(n - 1) * 3].toDouble()
		val by = points[(n - 1) * 3 + 1].toDouble()
		val len = hypot(bx - ax, by - ay)
		if (len < MIN_SEGMENT) return null
		val ux = (bx - ax) / len
		val uy = (by - ay) / len
		val mean = len / (n - 1)
		var px = ax
		var py = ay
		for (i in 1 until n) {
			val x = points[i * 3].toDouble()
			val y = points[i * 3 + 1].toDouble()
			if (abs((x - ax) * uy - (y - ay) * ux) > STRAIGHT_TOL) return null
			if (abs(hypot(x - px, y - py) - mean) > mean * GAP_TOL) return null
			px = x
			py = y
		}
		return Segment(ax, ay, bx, by)
	}

	/** The straight lines among the strokes' point lists. */
	fun segments(strokes: List<FloatArray>): List<Segment> = strokes.mapNotNull { segment(it) }

	/**
	 * The guide for a line drawn from (sx, sy) towards (ex, ey) (world px) at [zoom] (screen px per world px), or null when no
	 * straight line is within [NEAR_PX] of the start or the two are parallel. The nearest line wins; the vertex is its point
	 * closest to the start; the angle is the smaller of the two the lines make.
	 */
	fun guide(sx: Double, sy: Double, ex: Double, ey: Double, segments: List<Segment>, zoom: Double): Guide? {
		val len = hypot(ex - sx, ey - sy)
		if (len == 0.0 || zoom <= 0.0) return null
		var best: Segment? = null
		var bestX = 0.0
		var bestY = 0.0
		var bestD = Double.MAX_VALUE
		for (seg in segments) {
			val dx = seg.bx - seg.ax
			val dy = seg.by - seg.ay
			val len2 = dx * dx + dy * dy
			val t = if (len2 == 0.0) 0.0 else max(0.0, min(1.0, ((sx - seg.ax) * dx + (sy - seg.ay) * dy) / len2))
			val cx = seg.ax + dx * t
			val cy = seg.ay + dy * t
			val d = hypot(sx - cx, sy - cy)
			if (d * zoom <= NEAR_PX && d < bestD) {
				best = seg
				bestX = cx
				bestY = cy
				bestD = d
			}
		}
		val seg = best ?: return null
		val segLen = hypot(seg.bx - seg.ax, seg.by - seg.ay)
		// the other line's direction, turned to the side the new line leans towards, so the angle is the acute one
		val dx = (ex - sx) / len
		val dy = (ey - sy) / len
		var ux = (seg.bx - seg.ax) / segLen
		var uy = (seg.by - seg.ay) / segLen
		if (dx * ux + dy * uy < 0) {
			ux = -ux
			uy = -uy
		}
		val sweep = atan2(dx * uy - dy * ux, dx * ux + dy * uy) * 180.0 / PI
		if (abs(sweep) < MIN_ANGLE_DEG) return null
		val radius = min(min(max(ARC_RATIO * len * zoom, ARC_MIN_PX), ARC_MAX_PX), segLen * zoom)
		return Guide(bestX, bestY, atan2(dy, dx) * 180.0 / PI, sweep, abs(sweep).roundToInt(), radius)
	}
}
