package dev.learnharness.android

import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Smooth a stroke's samples before the native renderer builds it (owner, 2026-10-29: "the drawings are low res / jagged").
 * Touch samples are sparse (a finger moving fast gives one every 20 or more device px), the renderer joins them with straight
 * segments, and at high zoom those corners show as facets. A Catmull-Rom curve through the samples, written with a point
 * about every [MAX_STEP] page px, makes the same stroke round at any zoom. Display only: the stroke the web stores and the
 * model reads is still the raw samples. Pure, so `./gradlew test` covers it.
 */
object InkSmooth {
	/** Spacing of the written points, page CSS px. */
	const val MAX_STEP = 1f
	/** At most this many points between two samples (a pathological jump must not make a huge stroke). */
	const val MAX_PER_SEGMENT = 8

	/** Flat [x, y, pressure, …]: the same stroke with extra points along a smooth curve through the originals (all kept, in order). */
	fun densify(points: FloatArray, maxStep: Float = MAX_STEP): FloatArray {
		val n = points.size / 3
		if (n < 3) return points
		val out = ArrayList<Float>(points.size * 3)
		for (i in 0 until n - 1) {
			val i0 = max(i - 1, 0)
			val i3 = min(i + 2, n - 1)
			val x0 = points[i0 * 3]; val y0 = points[i0 * 3 + 1]
			val x1 = points[i * 3]; val y1 = points[i * 3 + 1]; val p1 = points[i * 3 + 2]
			val x2 = points[(i + 1) * 3]; val y2 = points[(i + 1) * 3 + 1]; val p2 = points[(i + 1) * 3 + 2]
			val x3 = points[i3 * 3]; val y3 = points[i3 * 3 + 1]
			val steps = min(MAX_PER_SEGMENT, max(1, ceil(hypot((x2 - x1).toDouble(), (y2 - y1).toDouble()) / maxStep).toInt()))
			for (s in 0 until steps) {
				val t = s.toFloat() / steps
				out.add(catmull(x0, x1, x2, x3, t))
				out.add(catmull(y0, y1, y2, y3, t))
				out.add(p1 + (p2 - p1) * t)
			}
		}
		out.add(points[(n - 1) * 3])
		out.add(points[(n - 1) * 3 + 1])
		out.add(points[(n - 1) * 3 + 2])
		return out.toFloatArray()
	}

	/** One coordinate of a uniform Catmull-Rom segment between p1 and p2 at t in [0, 1). */
	private fun catmull(p0: Float, p1: Float, p2: Float, p3: Float, t: Float): Float {
		val t2 = t * t
		val t3 = t2 * t
		return 0.5f * ((2f * p1) + (-p0 + p2) * t + (2f * p0 - 5f * p1 + 4f * p2 - p3) * t2 + (-p0 + 3f * p1 - 3f * p2 + p3) * t3)
	}
}
