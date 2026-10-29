package dev.learnharness.android

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Hold to straighten, native half (M16c, docs/android/m16-plan.md): hold the pen still at the end of a stroke and it
 * becomes a straight line, the angle snapped to multiples of 45 degrees within [SNAP_DEG]. Pure, so `./gradlew test`
 * covers it. Mirrors components/sketch/straight-line.ts (the web canvas does the same on its own strokes); the numbers
 * are the same on both.
 */
object InkStraight {
	/** The pen must stay inside [HOLD_RADIUS_DP] for this long. */
	const val HOLD_MS = 500L
	const val HOLD_RADIUS_DP = 4f
	/** A stroke shorter than this (CSS px on screen) is a dot or a tick, never a line. */
	const val MIN_LINE_DP = 24f
	const val SNAP_DEG = 5.0
	/** Spacing of the points a line is written with (world px). */
	private const val STEP = 6f

	/** (x, y) of `to`, moved to the nearest multiple of 45 degrees about `from` when within [tolDeg] of one; the length is kept. */
	fun snapAngle(fx: Float, fy: Float, tx: Float, ty: Float, tolDeg: Double = SNAP_DEG): Pair<Float, Float> {
		val len = hypot((tx - fx).toDouble(), (ty - fy).toDouble())
		if (len == 0.0) return tx to ty
		val deg = atan2((ty - fy).toDouble(), (tx - fx).toDouble()) * 180.0 / PI
		val nearest = (deg / 45.0).roundToInt() * 45.0
		if (abs(deg - nearest) > tolDeg) return tx to ty
		val rad = nearest * PI / 180.0
		return (fx + cos(rad) * len).toFloat() to (fy + sin(rad) * len).toFloat()
	}

	/** Flat [x, y, pressure, …] from `from` to `to`, both ends included, evenly spaced. */
	fun linePoints(fx: Float, fy: Float, tx: Float, ty: Float, pressure: Float = 0.5f): FloatArray {
		val n = max(1, ceil(hypot((tx - fx).toDouble(), (ty - fy).toDouble()) / STEP).toInt())
		val out = FloatArray((n + 1) * 3)
		for (i in 0..n) {
			val t = i.toFloat() / n
			out[i * 3] = fx + (tx - fx) * t
			out[i * 3 + 1] = fy + (ty - fy) * t
			out[i * 3 + 2] = pressure
		}
		return out
	}

	/** The stroke's points as a straight line from its first point to its last (or `endX`/`endY`), the angle snapped; null for fewer than two points. */
	fun straighten(points: FloatArray, endX: Float? = null, endY: Float? = null): FloatArray? {
		if (points.size < 6) return null
		val fx = points[0]
		val fy = points[1]
		val tx = endX ?: points[points.size - 3]
		val ty = endY ?: points[points.size - 2]
		val (sx, sy) = snapAngle(fx, fy, tx, ty)
		var sum = 0f
		var n = 0
		var i = 2
		while (i < points.size) {
			sum += points[i]
			n++
			i += 3
		}
		return linePoints(fx, fy, sx, sy, if (n > 0) sum / n else 0.5f)
	}

	/** Is the stroke long enough (first to last point, world px at this zoom) to be a line rather than a dot? */
	fun longEnough(points: FloatArray, zoom: Float): Boolean {
		if (points.size < 6) return false
		val d = hypot((points[points.size - 3] - points[0]).toDouble(), (points[points.size - 2] - points[1]).toDouble())
		return d * zoom >= MIN_LINE_DP
	}
}
