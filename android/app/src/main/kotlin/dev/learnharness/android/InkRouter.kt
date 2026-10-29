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
 * - The ink follows ONE pointer, named by id (M16): the one that began the stroke. A palm that lands beside the stylus, or stays
 *   down after it lifts, is never followed; a stylus that lands AFTER a palm or finger the page was following takes the
 *   gesture over (the page's touch is cancelled); a pointer the system cancelled (FLAG_CANCELED: a palm it rejected) never
 *   ends or draws a stroke of its own.
 */

data class InkPointer(val id: Int, val x: Float, val y: Float, val tool: Int, val buttons: Int = 0)

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
 * [inkPointerId]: the pointer id the ink layer follows (-1 when none). [startInk]: the event is a POINTER_DOWN that begins the
 * stroke (a stylus landing after a palm). [finishInk]: the followed pointer lifted while others stay down: end the stroke now.
 * [cancelWeb]: the page's touch (a palm it was following) is over: send it a cancel.
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
	val inkPointerId: Int = -1,
	val startInk: Boolean = false,
	val finishInk: Boolean = false,
	val cancelWeb: Boolean = false,
	)

class InkRouter {
	var penSeen = false
		private set
	private var mode = InkRoute.NONE
	private var trackedId = -1
	private var lastMeanX = 0f
	private var lastMeanY = 0f
	private var lastSpread = 0f

	/** [canceled]: the event carries FLAG_CANCELED (API 33): the system took the pointer at [actionIndex] back (a palm). */
	fun step(action: InkAction, pointers: List<InkPointer>, actionIndex: Int, surface: InkRect?, holes: List<InkRect>, canceled: Boolean = false): InkStep {
		if (pointers.isEmpty()) return InkStep(InkRoute.NONE)
		return when (action) {
			InkAction.DOWN -> {
				val p = pointers[actionIndex.coerceIn(0, pointers.size - 1)]
				val pen = isPen(p.tool)
				val seenNow = pen && !penSeen
				if (pen) penSeen = true
				val onCanvas = onCanvas(p, surface, holes)
				// a mouse's secondary or middle button is the page's (the web pans on a middle-drag), never ink
				val pageMouseButton = p.tool == TOOL_TYPE_MOUSE && (p.buttons and MOUSE_NON_PRIMARY) != 0
				mode = if (onCanvas && !pageMouseButton && (pen || !penSeen)) InkRoute.INK else InkRoute.WEB
				if (mode == InkRoute.INK) trackedId = p.id
				InkStep(mode, penSeenNow = seenNow, inkPointerId = if (mode == InkRoute.INK) p.id else -1)
			}
			InkAction.POINTER_DOWN -> when (mode) {
				InkRoute.INK ->
				if (!penSeen && pointers.none { isPen(it.tool) }) {
				mode = InkRoute.PAN
				baseline(pointers)
				InkStep(InkRoute.PAN, cancelInk = true)
				} else {
				InkStep(InkRoute.INK, inkPointerId = trackedId) // a palm beside a stylus: the layer follows the stylus pointer only
				}
				InkRoute.PAN -> {
				baseline(pointers)
				InkStep(InkRoute.PAN)
				}
				InkRoute.WEB -> {
				// a stylus landing on the canvas after a palm or finger the page was following takes the gesture over
				val p = pointers[actionIndex.coerceIn(0, pointers.size - 1)]
				if (isPen(p.tool) && onCanvas(p, surface, holes)) {
				val seenNow = !penSeen
				penSeen = true
				mode = InkRoute.INK
				trackedId = p.id
				InkStep(InkRoute.INK, penSeenNow = seenNow, inkPointerId = p.id, startInk = true, cancelWeb = true)
				} else {
				InkStep(mode)
				}
				}
				else -> InkStep(mode)
			}
			InkAction.MOVE -> when (mode) {
			InkRoute.INK -> InkStep(InkRoute.INK, inkPointerId = trackedId)
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
			InkStep(mode)
			} else if (mode == InkRoute.INK) {
			val lifted = pointers[actionIndex.coerceIn(0, pointers.size - 1)]
			if (lifted.id == trackedId) {
			// the followed pointer lifted (or was taken back by the system) while a palm stays: the stroke ends here, and the
			// palm's remaining events are swallowed
			mode = InkRoute.NONE
			if (canceled) InkStep(InkRoute.INK, cancelInk = true, inkPointerId = lifted.id) else InkStep(InkRoute.INK, finishInk = true, inkPointerId = lifted.id)
			} else {
			InkStep(InkRoute.INK, inkPointerId = trackedId) // a palm lifted (or was cancelled): nothing to do
			}
			} else {
			InkStep(mode)
			}
			}
			InkAction.UP, InkAction.CANCEL -> {
			val ended = mode
			val tracked = trackedId
			mode = InkRoute.NONE
			trackedId = -1
			if (ended == InkRoute.INK && canceled && action == InkAction.UP) {
			InkStep(InkRoute.INK, cancelInk = true, inkPointerId = tracked)
			} else {
			InkStep(if (ended == InkRoute.PAN) InkRoute.NONE else ended, inkPointerId = if (ended == InkRoute.INK) tracked else -1)
			}
			}
		}
	}

	private fun onCanvas(p: InkPointer, surface: InkRect?, holes: List<InkRect>): Boolean = surface != null && surface.contains(p.x, p.y) && holes.none { it.contains(p.x, p.y) }

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
		const val TOOL_TYPE_MOUSE = 3
		/** MotionEvent.BUTTON_SECONDARY (2) | BUTTON_TERTIARY (4). */
		const val MOUSE_NON_PRIMARY = 2 or 4
		fun isPen(tool: Int) = tool == TOOL_TYPE_STYLUS || tool == TOOL_TYPE_ERASER
	}
}
