package dev.learnharness.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.ink.authoring.InProgressStrokeId
import androidx.ink.authoring.InProgressStrokesFinishedListener
import androidx.ink.authoring.InProgressStrokesView
import androidx.ink.brush.Brush
import androidx.ink.brush.StockBrushes
import androidx.ink.strokes.Stroke
import androidx.input.motionprediction.MotionEventPredictor
import kotlin.math.hypot

/** What the layer reports (the web decides what to do with it). */
interface InkLayerListener {
	fun onStroke(stroke: InkWire.Stroke)
	fun onErase(points: FloatArray)
	/** The stroke eraser's gesture ended and the layer already removed what it touched: [count] strokes were held, [indices] went. */
	fun onErased(count: Int, indices: Set<Int>)
}

/** The pen's (or the eraser's) reach under a hovering stylus, as a thin ring. */
class HoverRing(context: Context) : View(context) {
	private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
		style = Paint.Style.STROKE
		strokeWidth = resources.displayMetrics.density
		color = 0xFF64748B.toInt()
	}
	private var cx = 0f
	private var cy = 0f
	private var radius = 0f
	private var shown = false

	init {
		isClickable = false
		isFocusable = false
	}

	/** Show the ring at (x, y) in this view's px, or hide it (null). */
	fun show(x: Float?, y: Float?, r: Float) {
		val on = x != null && y != null
		if (!on && !shown) return
		shown = on
		cx = x ?: 0f
		cy = y ?: 0f
		radius = r
		invalidate()
	}

	override fun onDraw(canvas: Canvas) {
		if (shown) canvas.drawCircle(cx, cy, radius, paint)
	}
}

/**
 * The native drawing surface: finished strokes under an androidx.ink InProgressStrokesView (front-buffered, with
 * motion prediction, as in the M9 spike). Gestures arrive through [handle] in the layer's own coordinates; the
 * layer turns them into page CSS px (screen density, the canvas' zoom and origin) for the web.
 *
 * One pointer draws, named by id (never "the first one"): a palm that lands beside the stylus, or stays after it lifts,
 * is not followed (M16). Hold the pen still at the end of a stroke and it becomes a straight line (M16c); the stroke eraser
 * fades the strokes it is over while it runs (M16).
 */
class InkLayer(context: Context) : FrameLayout(context) {
	val finished = FinishedStrokesView(context)
	private val inProgress = InProgressStrokesView(context)
	private val hoverRing = HoverRing(context)
	private val angleOverlay = AngleOverlay(context)
	private val predictor = MotionEventPredictor.newInstance(inProgress)
	private val density = resources.displayMetrics.density
	private var view = InkView()
	var eraser = false
	var listener: InkLayerListener? = null
	/** The page said `caps hits`: it takes the stroke eraser's hits (`erased`) instead of the path (`erase`). */
	var reportsHits = false

	private var id: InProgressStrokeId? = null
	private var points = ArrayList<Float>()
	private var erasing = false

	// the pen the web chose (`brush` line); the default is the web's default ink
	private var penColor: String? = null // null = the default ink
	private var penSize = PEN_SIZE

	// the eraser the web chose (`eraser` line)
	private var strokeEraser = false
	private var eraserRadius = 20f
	private val fadeHits = HashSet<InkWire.Stroke>()
	private var fadeChecked = 0
	private var trailChecked = 0

	// hold to straighten
	private val holdCheck = Runnable { onHold() }
	private var anchorX = 0f
	private var anchorY = 0f
	private var straight = false
	/** The straight lines already on the page, taken once when the hold fires (the angle guide measures against them). */
	private var angleSegments: List<InkAngle.Segment> = emptyList()

	/** The pen's colour (#rrggbb) and base size in CSS px, for the strokes drawn from now on. */
	fun setBrush(color: String, size: Float) {
		penColor = if (color.equals(DEFAULT_INK, ignoreCase = true)) null else color
		penSize = size
	}

	/** The eraser's mode and reach (CSS px on screen). */
	fun setEraser(strokeMode: Boolean, radiusCss: Float) {
		strokeEraser = strokeMode
		eraserRadius = radiusCss
	}

	private var dark = false

	/** The sheet's tone: the paper, the strokes and the live brush use the tone's colours. */
	fun setDark(on: Boolean) {
		dark = on
		finished.setDark(on)
	}

	private fun brush(): Brush {
		val argb = InkSheet.displayColor(penColor, dark)
		return Brush.createWithColorIntArgb(StockBrushes.pressurePen(), argb, penSize * density, 0.1f)
	}

	init {
		val match = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
		addView(finished, match)
		addView(inProgress, match)
		addView(hoverRing, match)
		addView(angleOverlay, match)
		inProgress.addFinishedStrokesListener(object : InProgressStrokesFinishedListener {
			override fun onStrokesFinished(strokes: Map<InProgressStrokeId, Stroke>) {
				// our own copy (from the recorded points) is already on the page layer
				inProgress.removeFinishedStrokes(strokes.keys)
				post { stopLibraryFrameLoop() } // after the library is done with this callback
			}
		})
	}

	/**
	 * androidx.ink 1.0.0 adds a FinishedShapesView inside the in-progress view the first time a stroke starts, and that view
	 * re-posts a Choreographer frame callback every frame for as long as it is attached, whether or not anything changes: after one
	 * stroke the main thread handled 120 vsyncs a second for nothing (about 11% of a core at idle, until the app was killed,
	 * measured 2026-11-07). It only draws strokes handed to it; ours are removed from it at once (above) and drawn by [finished],
	 * so it is taken out of the tree. Found by class name: a library that no longer has it is left alone.
	 */
	private fun stopLibraryFrameLoop() {
		val found = ArrayList<View>()
		fun walk(v: View) {
			if (v.javaClass.name == LIBRARY_FINISHED_VIEW) found += v
			if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
		}
		walk(inProgress)
		for (v in found) (v.parent as? ViewGroup)?.removeView(v)
	}

	fun setView(v: InkView) {
		view = v
		finished.setView(v)
	}

	/** A hovering stylus at (x, y) in this layer's px (null: gone): a ring the size of the pen's width, or the eraser's reach. */
	fun hover(x: Float?, y: Float?) {
		val r = if (eraser) eraserRadius * density else maxOf(1.5f * density, penSize * density / 2f)
		hoverRing.show(x, y, r)
	}

	/** Drop the gesture in progress (a second finger turned it into a scroll, or the system cancelled it). */
	fun cancel(event: MotionEvent?) {
		val current = id
		if (current != null && event != null) inProgress.cancelStroke(current, event)
		id = null
		points.clear()
		erasing = false
		finished.clearTrail()
		endGesture()
	}

	/** Everything a gesture leaves behind: the hold timer, a straight preview, the eraser's fade. */
	private fun endGesture() {
		removeCallbacks(holdCheck)
		straight = false
		angleSegments = emptyList()
		angleOverlay.show(null, 0f, 0f, 0)
		finished.setLive(null)
		fadeHits.clear()
		fadeChecked = 0
		trailChecked = 0 // the trail itself stays for a part-eraser gesture until the page answers (see holdTrail)
		finished.setFaded(emptySet())
	}

	/**
	 * One touch event, in this layer's coordinates. Only the pointer [pointerId] draws: the one the router chose when the
	 * gesture began. [start]: the event is a POINTER_DOWN that begins the stroke (the stylus landed after a palm); [finish]:
	 * the event is the lift of [pointerId] while others stay down (the stylus lifted first), so the stroke ends here.
	 */
	fun handle(event: MotionEvent, pointerId: Int = event.getPointerId(0), start: Boolean = false, finish: Boolean = false) {
		val index = event.findPointerIndex(pointerId)
		if (index < 0) return
		val action = when {
			start -> MotionEvent.ACTION_DOWN
			finish -> MotionEvent.ACTION_UP
			else -> event.actionMasked
		}
		when (action) {
			MotionEvent.ACTION_DOWN -> {
				points = ArrayList()
				endGesture()
				erasing = eraser || event.getToolType(index) == MotionEvent.TOOL_TYPE_ERASER || (event.buttonState and MotionEvent.BUTTON_STYLUS_PRIMARY) != 0
				if (!erasing) {
					requestUnbufferedDispatch(event)
					inProgress.requestUnbufferedDispatch(event)
					id = inProgress.startStroke(event, pointerId, brush())
					predictor.record(event)
					startHold(event.getX(index), event.getY(index))
				}
				record(event, index, historical = false)
				if (erasing) {
					updateFade()
					updateTrail()
				}
			}
			MotionEvent.ACTION_MOVE -> {
				val current = id
				if (!erasing && current != null) {
					predictor.record(event)
					val predicted = predictor.predict()
					inProgress.addToStroke(event, pointerId, current, predicted)
					predicted?.recycle()
				}
				if (current != null || erasing || straight) record(event, index, historical = true)
				if (straight) previewLine() else if (current != null) holdMoved(event.getX(index), event.getY(index))
				if (erasing) {
					updateFade()
					updateTrail()
				}
			}
			MotionEvent.ACTION_UP -> {
				val current = id
				if (erasing) {
					record(event, index, historical = false)
					if (strokeEraser && reportsHits) {
						// The hits were found while the gesture ran (the last samples now too): report them and drop those strokes from
						// what is shown at once. The page answers with an ack; it does not re-test the gesture or push the page back.
						updateFade()
						val all = finished.allRaw()
						val indices = all.indices.filterTo(LinkedHashSet()) { fadeHits.contains(all[it]) }
						listener?.onErased(all.size, indices)
						finished.removeStrokes(fadeHits)
					} else {
						updateTrail()
						listener?.onErase(InkWire.xyOf(points.toFloatArray()))
						finished.holdTrail() // gone when the page's cut arrives
					}
				} else if (straight) {
					record(event, index, historical = false)
					commitLine()
				} else if (current != null) {
					inProgress.finishStroke(event, pointerId, current)
					record(event, index, historical = false)
					val stroke = InkWire.Stroke(view.penWorldSize(penSize), penColor, points.toFloatArray())
					finished.addPending(stroke)
					listener?.onStroke(stroke)
				}
				id = null
				points = ArrayList()
				erasing = false
				endGesture()
			}
			MotionEvent.ACTION_CANCEL -> cancel(event)
		}
	}

	// ── hold to straighten ──────────────────────────────────────────────────

	private fun startHold(x: Float, y: Float) {
		anchorX = x
		anchorY = y
		removeCallbacks(holdCheck)
		postDelayed(holdCheck, InkStraight.HOLD_MS)
	}

	/** The pen moved: a move out of the hold radius restarts the wait; tremor inside it does not. */
	private fun holdMoved(x: Float, y: Float) {
		if (hypot(x - anchorX, y - anchorY) > InkStraight.HOLD_RADIUS_DP * density) startHold(x, y)
	}

	/** The pen has been still for HOLD_MS: if the stroke is long enough it becomes a straight line that follows the pen. */
	private fun onHold() {
		val current = id ?: return
		if (erasing || straight) return
		if (!InkStraight.longEnough(points.toFloatArray(), view.zoom)) return
		straight = true
		angleSegments = InkAngle.segments(finished.allRaw().map { it.points })
		inProgress.cancelStroke(current)
		id = null
		performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
		previewLine()
	}

	private fun line(): FloatArray? = InkStraight.straighten(points.toFloatArray())

	private fun previewLine() {
		val l = line() ?: return
		finished.setLive(InkWire.Stroke(view.penWorldSize(penSize), penColor, l))
		updateAngle(l)
	}

	/** The angle guide for the straight line `l` (flat points, world px), if its start is near another straight line. */
	private fun updateAngle(l: FloatArray) {
		val g = InkAngle.guide(
			l[0].toDouble(), l[1].toDouble(), l[l.size - 3].toDouble(), l[l.size - 2].toDouble(),
			angleSegments, view.zoom.toDouble(),
		)
		if (g == null) {
			angleOverlay.show(null, 0f, 0f, 0)
			return
		}
		angleOverlay.show(g, view.pxX(g.vx.toFloat(), density), view.pxY(g.vy.toFloat(), density), InkSheet.displayColor(penColor, dark))
	}

	private fun commitLine() {
		val l = line()
		finished.setLive(null)
		if (l == null) return
		val stroke = InkWire.Stroke(view.penWorldSize(penSize), penColor, l)
		finished.addPending(stroke)
		listener?.onStroke(stroke)
	}

	// ── the stroke eraser's fade ────────────────────────────────────────────

	/** Fade the strokes the eraser path has reached so far (the web decides what is erased, from the same rule, on lift). */
	private fun updateFade() {
		if (!strokeEraser) return
		val xy = InkWire.xyOf(points.toFloatArray())
		val pairs = xy.size / 2
		if (pairs <= fadeChecked) return
		val all = finished.allRaw()
		val before = fadeHits.size
		for (index in InkWire.eraseHits(all, xy, eraserRadius / view.zoom, fadeChecked)) all.getOrNull(index)?.let { fadeHits += it }
		fadeChecked = pairs
		// the fade only changes when the eraser reached another stroke: most moves reach none, and rebuilding the set per move was waste
		if (fadeHits.size != before) finished.setFaded(fadeHits)
	}

	/** The part eraser's trail follows the samples the gesture has recorded so far (page px). */
	private fun updateTrail() {
		if (strokeEraser) return
		val count = points.size / 3
		if (count == 0 || count <= trailChecked) return
		if (trailChecked == 0) {
			finished.startTrail(eraserRadius / view.zoom, points[0], points[1])
			trailChecked = 1
		}
		for (i in trailChecked until count) finished.extendTrail(points[i * 3], points[i * 3 + 1])
		trailChecked = count
	}

	private fun record(event: MotionEvent, index: Int, historical: Boolean) {
		if (historical) {
			for (h in 0 until event.historySize) add(event.getHistoricalX(index, h), event.getHistoricalY(index, h), event.getHistoricalPressure(index, h), event.getToolType(index))
		}
		add(event.getX(index), event.getY(index), event.getPressure(index), event.getToolType(index))
	}

	/** View px to world (page CSS) px; a finger has no real pressure (the web uses 0.5 too). */
	private fun add(x: Float, y: Float, pressure: Float, tool: Int) {
		points.add(view.worldX(x, density))
		points.add(view.worldY(y, density))
		points.add(if (InkRouter.isPen(tool) && pressure > 0f) pressure.coerceAtMost(1f) else 0.5f)
	}

	companion object {
		/** The web pen's base size in CSS px (`SKETCH_PEN_SIZE`). */
		const val PEN_SIZE = 4f
		private const val DEFAULT_INK = "#111111"
		private const val LIBRARY_FINISHED_VIEW = "androidx.ink.authoring.FinishedShapesView"
	}
}
