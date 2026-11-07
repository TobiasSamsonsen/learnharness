package dev.learnharness.android

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor

/**
 * What the finished-strokes view needs to avoid redoing work per frame, as pure maths (no Android types, so `./gradlew test`
 * covers it): which strokes are on screen, the box a recorded stroke occupies, when a recording is too far from the zoom to
 * look right, and the content key that lets a full `strokes` push reuse the ink it already converted.
 */

/**
 * A stroke by what it looks like (size, colour and every point), not by object: the web pushes the whole set again on undo,
 * redo, clear and cut, and the strokes in it are new objects holding the same numbers. [sent] is left out: it only decides how
 * the stroke is dimmed when drawn, never the ink itself.
 */
class StrokeKey(val stroke: InkWire.Stroke) {
	private val hash: Int = run {
		var h = stroke.points.contentHashCode()
		h = 31 * h + stroke.size.toBits()
		31 * h + (stroke.color?.hashCode() ?: 0)
	}

	override fun hashCode(): Int = hash

	override fun equals(other: Any?): Boolean {
		if (this === other) return true
		if (other !is StrokeKey) return false
		val a = stroke
		val b = other.stroke
		return hash == other.hash && a.size == b.size && a.color == b.color && a.points.contentEquals(b.points)
	}
}

object InkCull {
	/** How far past its points a stroke's outline can reach, page px: its width (the outline is half of it either side, plus smoothing). */
	fun reach(size: Float): Float = size

	/** Does a stroke with point box [bounds] ([minX, minY, maxX, maxY]) and width [size] meet the view rectangle? A stroke with no points never does. */
	fun visible(bounds: FloatArray?, size: Float, x0: Float, y0: Float, x1: Float, y1: Float): Boolean {
		if (bounds == null) return false
		val r = reach(size)
		return !(bounds[2] + r < x0 || bounds[0] - r > x1 || bounds[3] + r < y0 || bounds[1] - r > y1)
	}

	/** The whole-pixel box [left, top, right, bottom], page px, a recording of the stroke covers (never empty). */
	fun nodeBox(bounds: FloatArray, size: Float): IntArray {
		val r = reach(size)
		val l = floor(bounds[0] - r).toInt()
		val t = floor(bounds[1] - r).toInt()
		return intArrayOf(l, t, maxOf(l + 1, ceil(bounds[2] + r).toInt()), maxOf(t + 1, ceil(bounds[3] + r).toInt()))
	}

	/** A recording keeps the soft edge it was made with: it is wrong once the screen scale has moved this far (a fraction) from it. */
	const val SCALE_TOLERANCE = 0.08f

	fun scaleStale(recorded: Float, now: Float): Boolean = recorded <= 0f || abs(now - recorded) > recorded * SCALE_TOLERANCE
}
