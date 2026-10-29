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

	/** The pen's width in world units for a width chosen as how it should FEEL on screen (the web's penWorldSize). */
	fun penWorldSize(screenSize: Float): Float {
		val v = (screenSize / zoom).coerceIn(MIN_WORLD_SIZE, MAX_WORLD_SIZE)
		return (v * 100f).roundToInt() / 100f
	}

	companion object {
		const val MIN_ZOOM = 0.1f
		const val MAX_ZOOM = 8f
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
