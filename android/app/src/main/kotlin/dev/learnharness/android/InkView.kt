package dev.learnharness.android

import java.util.Locale
import kotlin.math.roundToInt

/**
 * The infinite canvas's view (Android plan M13c), pure so `./gradlew test` covers it. The page is an unbounded plane
 * of WORLD coordinates (CSS px, any origin); [x], [y] are the world coordinates of the layer's top-left corner and
 * [zoom] is CSS px on screen per world unit. The WEB owns the view (it sends `view <zoom> <x> <y>`): the shell only
 * draws through it and reports raw gestures, exactly as it does with the strokes. Mirrors
 * components/sketch/view-transform.ts.
 */
data class InkView(val zoom: Float = 1f, val x: Float = 0f, val y: Float = 0f) {
	/** A layer point in device px to the world. */
	fun worldX(px: Float, density: Float): Float = px / (density * zoom) + x
	fun worldY(py: Float, density: Float): Float = py / (density * zoom) + y

	/** A world point to the layer, in device px (the inverse of [worldX] / [worldY]). */
	fun pxX(wx: Float, density: Float): Float = (wx - x) * density * zoom
	fun pxY(wy: Float, density: Float): Float = (wy - y) * density * zoom

	/**
	 * The pen's width in world units (the web's penWorldSize): a size on the page, the chosen width up to 1x zoom, then
	 * linear down to [PEN_FACTOR_AT_MAX_ZOOM] of it at [MAX_ZOOM] (a little finer zoomed in, for subscripts).
	 */
	fun penWorldSize(size: Float): Float {
		val t = ((zoom - 1f) / (MAX_ZOOM - 1f)).coerceIn(0f, 1f)
		val v = (size * (1f - (1f - PEN_FACTOR_AT_MAX_ZOOM) * t)).coerceIn(MIN_WORLD_SIZE, MAX_WORLD_SIZE)
		return (v * 100f).roundToInt() / 100f
	}

	companion object {
		/** Narrow on purpose (the web's MIN_ZOOM / MAX_ZOOM): the writing size can drift at most 6x between two strokes. */
		const val MIN_ZOOM = 0.5f
		const val MAX_ZOOM = 3f
		private const val PEN_FACTOR_AT_MAX_ZOOM = 0.8f
		private const val MIN_WORLD_SIZE = 0.5f
		private const val MAX_WORLD_SIZE = 64f

		/** The `view` line's three numbers, or null when they are not a usable view. */
		fun parse(zoom: Float?, x: Float?, y: Float?): InkView? {
			if (zoom == null || x == null || y == null) return null
			if (!zoom.isFinite() || !x.isFinite() || !y.isFinite() || zoom < MIN_ZOOM || zoom > MAX_ZOOM) return null
			return InkView(zoom, x, y)
		}

		fun format(v: Float): String = String.format(Locale.ROOT, "%.2f", v)
	}
}
