package dev.learnharness.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.ink.authoring.InProgressStrokeId
import androidx.ink.authoring.InProgressStrokesFinishedListener
import androidx.ink.authoring.InProgressStrokesView
import androidx.ink.brush.Brush
import androidx.ink.brush.InputToolType
import androidx.ink.brush.StockBrushes
import androidx.ink.rendering.android.canvas.CanvasStrokeRenderer
import androidx.ink.strokes.MutableStrokeInputBatch
import androidx.ink.strokes.Stroke
import androidx.ink.strokes.StrokeInput
import androidx.input.motionprediction.MotionEventPredictor
import java.util.Collections
import java.util.IdentityHashMap
import kotlin.math.hypot

/**
 * The finished strokes of the page, on the white page (the web canvas is always white): drawn with the renderer the
 * in-progress strokes use, so a stroke does not change look when it finishes. Strokes live in the canvas' page CSS px;
 * the view scales by the screen density and the infinite canvas's zoom and shifts by its origin (see [InkView]). [add] /
 * [clear] are the plain-stroke API the M9 spike uses.
 */
class FinishedStrokesView(context: Context) : View(context) {
	/** A stroke as ink draws it, with the wire stroke it came from (the eraser's fade is told which wire strokes it touches). */
	private class Drawn(val raw: InkWire.Stroke, val stroke: Stroke)

	private val renderer = CanvasStrokeRenderer.create()
	private val plain = ArrayList<Stroke>()
	private var strokes: List<Drawn> = emptyList()
	private var kept: List<Drawn> = emptyList()
	private var pending: List<Drawn> = emptyList()
	// the wire strokes behind the ink above: a change of sheet tone rebuilds the ink in the new colours
	private var strokesRaw: List<InkWire.Stroke> = emptyList()
	private var keptRaw: List<InkWire.Stroke> = emptyList()
	private var pendingRaw: List<InkWire.Stroke> = emptyList()
	/** The stroke being held straight (M16c): drawn like a pending stroke until the pen lifts. */
	private var live: Stroke? = null
	/** The strokes the stroke eraser is over (M16): drawn faint until the gesture ends. */
	private var faded: Set<InkWire.Stroke> = emptySet()
	private var dark = false
	// The part eraser's trail: while it runs, a paper-coloured stroke as wide as its reach follows the pen over the ink, so what is
	// under it is gone at once. The page's exact cut replaces it when it answers (setStrokes / ackPending), or a safety stop does.
	private val trailPath = Path()
	private var trailing = false
	private var trailRadius = 0f
	private val trailPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
		style = Paint.Style.STROKE
		strokeCap = Paint.Cap.ROUND
		strokeJoin = Paint.Join.ROUND
	}
	private val stopTrail = Runnable { clearTrail() }
	private val matrix = Matrix()
	private val identity = Matrix()
	private var density = 1f
	private var view = InkView()
var paper = Color.WHITE

	init {
		density = resources.displayMetrics.density
	}

	fun add(more: Collection<Stroke>) {
		plain += more
		invalidate()
	}

	fun clear() {
		plain.clear()
		strokes = emptyList()
		kept = emptyList()
		pending = emptyList()
		strokesRaw = emptyList()
		keptRaw = emptyList()
		pendingRaw = emptyList()
		live = null
		faded = emptySet()
		clearTrail()
		invalidate()
	}

	/**
	 * Every wire stroke the eraser can reach, in the order the page numbers them: the working page (finished ones first, then the ones
	 * the web has not acknowledged yet), then the sent page (the kept strokes, drawn dimmed).
	 */
	fun allRaw(): List<InkWire.Stroke> = strokesRaw + pendingRaw + keptRaw

	fun setStrokes(list: List<InkWire.Stroke>) {
		strokesRaw = list
		strokes = drawn(list)
		pendingRaw = emptyList()
		pending = emptyList() // the web's set now holds what we had drawn ahead of it
		clearTrail() // the page's answer to a part-eraser gesture is the new strokes: its cut replaces the trail
		invalidate()
	}

	fun setKept(list: List<InkWire.Stroke>) {
		keptRaw = list
		kept = drawn(list)
		invalidate()
	}

	/** The part eraser began at (x, y) (page px) with a reach of [radiusWorld]: its trail starts there. */
	fun startTrail(radiusWorld: Float, x: Float, y: Float) {
		removeCallbacks(stopTrail)
		trailPath.rewind()
		trailPath.moveTo(x, y)
		trailPath.lineTo(x + 0.01f, y) // a round-capped zero-length stroke is a dot
		trailRadius = radiusWorld
		trailing = true
		invalidate()
	}

	fun extendTrail(x: Float, y: Float) {
		if (!trailing) return
		trailPath.lineTo(x, y)
		invalidate()
	}

	/** The gesture ended and the page has its path: the trail stays until the page's cut arrives (a safety stop if none ever does). */
	fun holdTrail() {
		if (!trailing) return
		removeCallbacks(stopTrail)
		postDelayed(stopTrail, TRAIL_HOLD_MS)
	}

	fun clearTrail() {
		removeCallbacks(stopTrail)
		if (!trailing) return
		trailing = false
		trailPath.rewind()
		invalidate()
	}

	/** A stroke just finished here, drawn until the web either acknowledges it or pushes a full set. */
	fun addPending(stroke: InkWire.Stroke) {
		pendingRaw = pendingRaw + stroke
		toInk(stroke)?.let { pending = pending + Drawn(stroke, it) }
		invalidate()
	}

	/** The web has the pending strokes in its store: they are part of the page now. */
	fun ackPending() {
		strokes = strokes + pending
		strokesRaw = strokesRaw + pendingRaw
		pendingRaw = emptyList()
		pending = emptyList()
		clearTrail()
		invalidate()
	}

	fun setView(v: InkView) {
		view = v
		invalidate()
	}

	/** The stroke held straight, shown until it is committed (null: none). */
	fun setLive(stroke: InkWire.Stroke?) {
		live = stroke?.let { toInk(it) }
		invalidate()
	}

	/**
	 * The stroke eraser's hits, gone now: dropped from what is shown without rebuilding the others (identity, from [allRaw]). The web
	 * then holds the same strokes, and its `ack` keeps this state; a full `strokes` push would replace it, as always.
	 */
	fun removeStrokes(gone: Set<InkWire.Stroke>) {
		if (gone.isEmpty()) return
		strokes = strokes.filter { it.raw !in gone }
		strokesRaw = strokesRaw.filter { it !in gone }
		pending = pending.filter { it.raw !in gone }
		pendingRaw = pendingRaw.filter { it !in gone }
		kept = kept.filter { it.raw !in gone }
		keptRaw = keptRaw.filter { it !in gone }
		invalidate()
	}

	/** The wire strokes the stroke eraser is over (identity, from [allRaw]); empty when the gesture ends. */
	fun setFaded(strokes: Collection<InkWire.Stroke>) {
		val set = Collections.newSetFromMap(IdentityHashMap<InkWire.Stroke, Boolean>())
		set.addAll(strokes)
		if (set.size == faded.size && set.containsAll(faded)) return
		faded = set
		invalidate()
	}

	/** The sheet's tone: the paper and every stroke are shown in the tone's colours (see [InkSheet]). */
	fun setDark(on: Boolean) {
		if (dark == on) return
		dark = on
		paper = if (on) InkSheet.DARK_PAPER else InkSheet.LIGHT_PAPER
		strokes = drawn(strokesRaw)
		kept = drawn(keptRaw)
		pending = drawn(pendingRaw)
		invalidate()
	}

	private fun drawn(list: List<InkWire.Stroke>): List<Drawn> = list.mapNotNull { raw -> toInk(raw)?.let { Drawn(raw, it) } }

	override fun onDraw(canvas: Canvas) {
		canvas.drawColor(paper)
		val scale = density * view.zoom
		matrix.setScale(scale, scale)
		matrix.postTranslate(-view.x * scale, -view.y * scale)
		// The page transform goes on the canvas (that is what PLACES the strokes: the renderer does not move them) AND is handed
		// to the renderer, which sizes its soft anti-aliasing edge from the stroke-to-screen transform it is given. Passing an
		// identity there while the canvas was scaled made every edge 1x-sized and then stretched: thick and blurry at zoom 459%
		// (found on the phone, 2026-10-29). Passing it WITHOUT scaling the canvas left the strokes at the same spot on the screen.
		val page = canvas.save()
		canvas.concat(matrix)
		val fade = faded
		// Sent ink is drawn dimmed: the kept page, and the sent strokes the web copied into the working page when the eraser first
		// touched them (`sent`): only what is new, and the pieces left of what was cut, is drawn in full (as the web canvas does)
		if (kept.isNotEmpty() || strokes.any { it.raw.sent }) {
			val save = canvas.saveLayerAlpha(null, (KEPT_ALPHA * 255).toInt())
			for (d in kept) if (!fade.contains(d.raw)) renderer.draw(canvas, d.stroke, matrix)
			for (d in strokes) if (d.raw.sent && !fade.contains(d.raw)) renderer.draw(canvas, d.stroke, matrix)
			canvas.restoreToCount(save)
		}
		for (d in strokes) if (!d.raw.sent && !fade.contains(d.raw)) renderer.draw(canvas, d.stroke, matrix)
		for (d in pending) if (!fade.contains(d.raw)) renderer.draw(canvas, d.stroke, matrix)
		if (fade.isNotEmpty()) {
			// the strokes the stroke eraser is over fade until the gesture ends (the web canvas does the same)
			val save = canvas.saveLayerAlpha(null, (FADE_ALPHA * 255).toInt())
			for (d in kept) if (fade.contains(d.raw)) renderer.draw(canvas, d.stroke, matrix)
			for (d in strokes) if (fade.contains(d.raw)) renderer.draw(canvas, d.stroke, matrix)
			for (d in pending) if (fade.contains(d.raw)) renderer.draw(canvas, d.stroke, matrix)
			canvas.restoreToCount(save)
		}
		if (trailing) {
			trailPaint.color = paper
			trailPaint.strokeWidth = 2f * (trailRadius + TRAIL_MARGIN)
			canvas.drawPath(trailPath, trailPaint)
		}
		live?.let { renderer.draw(canvas, it, matrix) }
		canvas.restoreToCount(page)
		for (stroke in plain) renderer.draw(canvas, stroke, identity)
	}

	private fun toInk(s: InkWire.Stroke): Stroke? = try {
		val color = InkSheet.displayColor(s.color, dark)
		// the mesh tolerance is in page px, so it shows as facets when zoomed in: 0.03 stays under a device pixel up to 8x
		val brush = Brush.createWithColorIntArgb(StockBrushes.pressurePen(), color, s.size, EPSILON)
		val batch = MutableStrokeInputBatch()
		var t = 0L
		var i = 0
		// a curve through the sparse touch samples, so the stroke is round at any zoom (display only, see InkSmooth)
		val pts = InkSmooth.densify(s.points)
		while (i + 2 < pts.size) {
		batch.add(InputToolType.STYLUS, pts[i], pts[i + 1], t, StrokeInput.NO_STROKE_UNIT_LENGTH, pts[i + 2].coerceIn(0f, 1f))
		t += 8
		i += 3
		}
		Stroke(brush, batch)
	} catch (_: RuntimeException) {
		null // a stroke ink cannot build is left out, never a crash
	}

	companion object {
		const val INK_COLOR = 0xFF111111.toInt()
		const val KEPT_ALPHA = 0.45f
		/** The strokes the stroke eraser is over (the web canvas fades them to 0.2 too). */
		const val FADE_ALPHA = 0.2f
		/** The part eraser's trail is as wide as its reach plus this (half a typical pen width): the web cuts the reach plus half the stroke. */
		const val TRAIL_MARGIN = 2f
		/** The longest the trail waits for the page's cut after the pen lifts. */
		const val TRAIL_HOLD_MS = 1000L
		/** The finished strokes' mesh tolerance, page px (it was 0.1: visible as facets at high zoom). */
		const val EPSILON = 0.03f
		}
}

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
		inProgress.addFinishedStrokesListener(object : InProgressStrokesFinishedListener {
			override fun onStrokesFinished(strokes: Map<InProgressStrokeId, Stroke>) {
				// our own copy (from the recorded points) is already on the page layer
				inProgress.removeFinishedStrokes(strokes.keys)
			}
		})
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
		inProgress.cancelStroke(current)
		id = null
		performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
		previewLine()
	}

	private fun line(): FloatArray? = InkStraight.straighten(points.toFloatArray())

	private fun previewLine() {
		val l = line() ?: return
		finished.setLive(InkWire.Stroke(view.penWorldSize(penSize), penColor, l))
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
	}
}
