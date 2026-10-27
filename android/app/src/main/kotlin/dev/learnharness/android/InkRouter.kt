package dev.learnharness.android

/**
 * Who gets a touch while the native ink layer is open (owner decision A, 2026-10-27: mirror the web canvas).
 * Pure: no Android types, so `./gradlew test` covers it.
 *
 * - A real stylus (its tip or its eraser end) draws on the canvas, except where web UI covers it (a hole).
 * - Until a real stylus has been seen, ONE FINGER draws too, and a second finger turns the gesture into a page
 *   scroll (the stroke the first finger began is dropped). This is the owner's phone: a capacitive stylus is a finger
 *   to Android (`TOOL_TYPE_FINGER`, verified in the layer spike).
 * - Once a real stylus has been seen, touch goes to the WebView, which scrolls and taps.
 * - A gesture keeps its target from DOWN to UP.
 */

data class InkPointer(val id: Int, val x: Float, val y: Float, val tool: Int)

enum class InkAction { DOWN, POINTER_DOWN, MOVE, POINTER_UP, UP, CANCEL }

enum class InkRoute {
	/** Deliver to the ink layer. */
	INK,
	/** Deliver to the WebView. */
	WEB,
	/** Swallow it and scroll the page by [InkStep.panDy]. */
	PAN,
	/** Swallow it. */
	NONE,
}

/** [cancelInk]: drop the stroke in progress. [panDy]: finger movement in px this step (positive = fingers moved down). */
data class InkStep(val route: InkRoute, val cancelInk: Boolean = false, val panDy: Float = 0f, val penSeenNow: Boolean = false)

class InkRouter {
	var penSeen = false
		private set
	private var mode = InkRoute.NONE
	private var lastMeanY = 0f

	fun step(action: InkAction, pointers: List<InkPointer>, actionIndex: Int, surface: InkRect?, holes: List<InkRect>): InkStep {
		if (pointers.isEmpty()) return InkStep(InkRoute.NONE)
		return when (action) {
			InkAction.DOWN -> {
				val p = pointers[actionIndex.coerceIn(0, pointers.size - 1)]
				val pen = isPen(p.tool)
				val seenNow = pen && !penSeen
				if (pen) penSeen = true
				val onCanvas = surface != null && surface.contains(p.x, p.y) && holes.none { it.contains(p.x, p.y) }
				mode = if (onCanvas && (pen || !penSeen)) InkRoute.INK else InkRoute.WEB
				InkStep(mode, penSeenNow = seenNow)
			}
			InkAction.POINTER_DOWN -> when (mode) {
				InkRoute.INK ->
					if (!penSeen && pointers.none { isPen(it.tool) }) {
						mode = InkRoute.PAN
						lastMeanY = meanY(pointers)
						InkStep(InkRoute.PAN, cancelInk = true)
					} else {
						InkStep(InkRoute.INK) // a palm beside a stylus: the layer follows the stylus pointer only
					}
				InkRoute.PAN -> {
					lastMeanY = meanY(pointers)
					InkStep(InkRoute.PAN)
				}
				else -> InkStep(mode)
			}
			InkAction.MOVE -> when (mode) {
				InkRoute.PAN -> {
					val m = meanY(pointers)
					val dy = m - lastMeanY
					lastMeanY = m
					InkStep(InkRoute.PAN, panDy = dy)
				}
				else -> InkStep(mode)
			}
			InkAction.POINTER_UP -> {
				if (mode == InkRoute.PAN) {
					val remaining = pointers.filterIndexed { i, _ -> i != actionIndex }
					if (remaining.isNotEmpty()) lastMeanY = meanY(remaining)
				}
				InkStep(mode)
			}
			InkAction.UP, InkAction.CANCEL -> {
				val ended = mode
				mode = InkRoute.NONE
				InkStep(if (ended == InkRoute.PAN) InkRoute.NONE else ended)
			}
		}
	}

	private fun meanY(pointers: List<InkPointer>) = pointers.map { it.y }.average().toFloat()

	companion object {
		const val TOOL_TYPE_STYLUS = 2
		const val TOOL_TYPE_ERASER = 4
		fun isPen(tool: Int) = tool == TOOL_TYPE_STYLUS || tool == TOOL_TYPE_ERASER
	}
}
