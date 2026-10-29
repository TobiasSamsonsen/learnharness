package dev.learnharness.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
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

/**
 * The finished strokes of the page, on the white page (the web canvas is always white): drawn with the renderer the
 * in-progress strokes use, so a stroke does not change look when it finishes. Strokes live in the canvas' page CSS px;
 * the view scales by the screen density and the infinite canvas's zoom and shifts by its origin (see [InkView]). [add] /
 * [clear] are the plain-stroke API the M9 spike uses.
 */
class FinishedStrokesView(context: Context) : View(context) {
	private val renderer = CanvasStrokeRenderer.create()
	private val plain = ArrayList<Stroke>()
	private var strokes: List<Stroke> = emptyList()
	private var kept: List<Stroke> = emptyList()
	private var pending: List<Stroke> = emptyList()
	// the wire strokes behind the ink above: a change of sheet tone rebuilds the ink in the new colours
	private var strokesRaw: List<InkWire.Stroke> = emptyList()
	private var keptRaw: List<InkWire.Stroke> = emptyList()
	private var pendingRaw: List<InkWire.Stroke> = emptyList()
	private var dark = false
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
		invalidate()
	}

	fun setStrokes(list: List<InkWire.Stroke>) {
		strokesRaw = list
		strokes = list.mapNotNull { toInk(it) }
		pendingRaw = emptyList()
		pending = emptyList() // the web's set now holds what we had drawn ahead of it
		invalidate()
	}

	fun setKept(list: List<InkWire.Stroke>) {
		keptRaw = list
		kept = list.mapNotNull { toInk(it) }
		invalidate()
	}

	/** A stroke just finished here, drawn until the web either acknowledges it or pushes a full set. */
	fun addPending(stroke: InkWire.Stroke) {
		pendingRaw = pendingRaw + stroke
		toInk(stroke)?.let { pending = pending + it }
		invalidate()
	}

	/** The web has the pending strokes in its store: they are part of the page now. */
	fun ackPending() {
		strokes = strokes + pending
		strokesRaw = strokesRaw + pendingRaw
		pendingRaw = emptyList()
		pending = emptyList()
		invalidate()
	}

	fun setView(v: InkView) {
		view = v
		invalidate()
	}

	/** The sheet's tone: the paper and every stroke are shown in the tone's colours (see [InkSheet]). */
	fun setDark(on: Boolean) {
		if (dark == on) return
		dark = on
		paper = if (on) InkSheet.DARK_PAPER else InkSheet.LIGHT_PAPER
		strokes = strokesRaw.mapNotNull { toInk(it) }
		kept = keptRaw.mapNotNull { toInk(it) }
		pending = pendingRaw.mapNotNull { toInk(it) }
		invalidate()
	}

	override fun onDraw(canvas: Canvas) {
		canvas.drawColor(paper)
		val scale = density * view.zoom
		matrix.setScale(scale, scale)
		matrix.postTranslate(-view.x * scale, -view.y * scale)
		// the page transform goes on the canvas: the renderer then draws in CSS px like the web canvas does
		val page = canvas.save()
		canvas.concat(matrix)
		if (kept.isNotEmpty()) {
			val save = canvas.saveLayerAlpha(null, (KEPT_ALPHA * 255).toInt())
			for (stroke in kept) renderer.draw(canvas, stroke, identity)
			canvas.restoreToCount(save)
		}
		for (stroke in strokes) renderer.draw(canvas, stroke, identity)
		for (stroke in pending) renderer.draw(canvas, stroke, identity)
		canvas.restoreToCount(page)
		for (stroke in plain) renderer.draw(canvas, stroke, identity)
	}

	private fun toInk(s: InkWire.Stroke): Stroke? = try {
		val color = InkSheet.displayColor(s.color, dark)
		val brush = Brush.createWithColorIntArgb(StockBrushes.pressurePen(), color, s.size, 0.1f)
		val batch = MutableStrokeInputBatch()
		var t = 0L
		var i = 0
		while (i + 2 < s.points.size) {
			batch.add(InputToolType.STYLUS, s.points[i], s.points[i + 1], t, StrokeInput.NO_STROKE_UNIT_LENGTH, s.points[i + 2].coerceIn(0f, 1f))
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
	}
}

/** What the layer reports (the web decides what to do with it). */
interface InkLayerListener {
	fun onStroke(stroke: InkWire.Stroke)
	fun onErase(points: FloatArray)
}

/**
 * The native drawing surface: finished strokes under an androidx.ink InProgressStrokesView (front-buffered, with
 * motion prediction, as in the M9 spike). Gestures arrive through [handle] in the layer's own coordinates; the
 * layer turns them into page CSS px (screen density, the canvas' zoom and origin) for the web.
 */
class InkLayer(context: Context) : FrameLayout(context) {
	val finished = FinishedStrokesView(context)
	private val inProgress = InProgressStrokesView(context)
	private val predictor = MotionEventPredictor.newInstance(inProgress)
	private val density = resources.displayMetrics.density
	private var view = InkView()
	var eraser = false
	var listener: InkLayerListener? = null

	private var id: InProgressStrokeId? = null
	private var points = ArrayList<Float>()
	private var erasing = false

	// the pen the web chose (`brush` line); the default is the web's default ink
	private var penColor: String? = null // null = the default ink
	private var penSize = PEN_SIZE

	/** The pen's colour (#rrggbb) and base size in CSS px, for the strokes drawn from now on. */
	fun setBrush(color: String, size: Float) {
		penColor = if (color.equals(DEFAULT_INK, ignoreCase = true)) null else color
		penSize = size
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

	/** Drop the gesture in progress (a second finger turned it into a scroll, or the system cancelled it). */
	fun cancel(event: MotionEvent?) {
		val current = id
		if (current != null && event != null) inProgress.cancelStroke(current, event)
		id = null
		points.clear()
		erasing = false
	}

	/** One touch event, in this layer's coordinates. Only the first pointer draws. */
	fun handle(event: MotionEvent) {
		when (event.actionMasked) {
			MotionEvent.ACTION_DOWN -> {
				points = ArrayList()
				erasing = eraser || event.getToolType(0) == MotionEvent.TOOL_TYPE_ERASER || (event.buttonState and MotionEvent.BUTTON_STYLUS_PRIMARY) != 0
				if (!erasing) {
					requestUnbufferedDispatch(event)
					inProgress.requestUnbufferedDispatch(event)
					id = inProgress.startStroke(event, event.getPointerId(0), brush())
					predictor.record(event)
				}
				record(event, historical = false)
			}
			MotionEvent.ACTION_MOVE -> {
				val current = id
				if (!erasing && current != null) {
					predictor.record(event)
					val predicted = predictor.predict()
					inProgress.addToStroke(event, event.getPointerId(0), current, predicted)
					predicted?.recycle()
				}
				if (current != null || erasing) record(event, historical = true)
			}
			MotionEvent.ACTION_UP -> {
				val current = id
				if (erasing) {
					record(event, historical = false)
					listener?.onErase(InkWire.xyOf(points.toFloatArray()))
				} else if (current != null) {
					inProgress.finishStroke(event, event.getPointerId(0), current)
					record(event, historical = false)
					val stroke = InkWire.Stroke(view.penWorldSize(penSize), penColor, points.toFloatArray())
					finished.addPending(stroke)
					listener?.onStroke(stroke)
				}
				id = null
				points = ArrayList()
				erasing = false
			}
			MotionEvent.ACTION_CANCEL -> cancel(event)
		}
	}

	private fun record(event: MotionEvent, historical: Boolean) {
		if (historical) {
			for (h in 0 until event.historySize) add(event.getHistoricalX(0, h), event.getHistoricalY(0, h), event.getHistoricalPressure(0, h), event.getToolType(0))
		}
		add(event.getX(0), event.getY(0), event.getPressure(0), event.getToolType(0))
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
