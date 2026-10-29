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

/**
 * [cancelInk]: drop the stroke in progress. For a [InkRoute.PAN] step: [panDx], [panDy] are the fingers' midpoint movement
 * in px this step (positive = right / down), [scale] the change in how far apart the fingers are (1 = no pinch), and
 * [focusX], [focusY] the midpoint after the move, in the router's own coordinates (device px).
 */
data class InkStep(
	val route: InkRoute,
	val cancelInk: Boolean = false,
	val panDy: Float = 0f,
	val penSeenNow: Boolean = false,
	val panDx: Float = 0f,
	val scale: Float = 1f,
	val focusX: Float = 0f,
	val focusY: Float = 0f,
)

class InkRouter {
	var penSeen = false
		private set
	private var mode = InkRoute.NONE
	private var lastMeanX = 0f
	private var lastMeanY = 0f
	private var lastSpread = 0f

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
						baseline(pointers)
						InkStep(InkRoute.PAN, cancelInk = true)
					} else {
						InkStep(InkRoute.INK) // a palm beside a stylus: the layer follows the stylus pointer only
					}
				InkRoute.PAN -> {
					baseline(pointers)
					InkStep(InkRoute.PAN)
				}
				else -> InkStep(mode)
			}
			InkAction.MOVE -> when (mode) {
				InkRoute.PAN -> {
					val mx = meanX(pointers)
					val my = meanY(pointers)
					val spread = spreadOf(pointers)
					// a pinch only while two or more fingers were down at both ends of the step
					val scale = if (lastSpread > 0f && spread > 0f) spread / lastSpread else 1f
					val step = InkStep(InkRoute.PAN, panDx = mx - lastMeanX, panDy = my - lastMeanY, scale = scale, focusX = mx, focusY = my)
					lastMeanX = mx
					lastMeanY = my
					lastSpread = spread
					step
				}
				else -> InkStep(mode)
			}
			InkAction.POINTER_UP -> {
				if (mode == InkRoute.PAN) {
					val remaining = pointers.filterIndexed { i, _ -> i != actionIndex }
					if (remaining.isNotEmpty()) baseline(remaining)
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

	private fun meanX(pointers: List<InkPointer>) = pointers.map { it.x }.average().toFloat()

	private fun meanY(pointers: List<InkPointer>) = pointers.map { it.y }.average().toFloat()

	/** How far apart the fingers are: their mean distance from the midpoint (0 with one finger). */
	private fun spreadOf(pointers: List<InkPointer>): Float {
		if (pointers.size < 2) return 0f
		val mx = meanX(pointers)
		val my = meanY(pointers)
		return pointers.map { Math.hypot((it.x - mx).toDouble(), (it.y - my).toDouble()) }.average().toFloat()
	}

	/** The fingers now down are the reference for the next move (no jump when one is added or lifted). */
	private fun baseline(pointers: List<InkPointer>) {
		lastMeanX = meanX(pointers)
		lastMeanY = meanY(pointers)
		lastSpread = spreadOf(pointers)
	}

	companion object {
		const val TOOL_TYPE_STYLUS = 2
		const val TOOL_TYPE_ERASER = 4
		fun isPen(tool: Int) = tool == TOOL_TYPE_STYLUS || tool == TOOL_TYPE_ERASER
	}
}
