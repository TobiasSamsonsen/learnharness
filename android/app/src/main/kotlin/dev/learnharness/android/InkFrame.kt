package dev.learnharness.android

import android.content.Context
import android.graphics.Color
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout

/**
 * The WebView plus, when the page asks for it, a native ink layer UNDER the (then transparent) WebView
 * (Android plan M10). The page's toolbar, floating box and dialogs are web UI drawn above the ink; the canvas area is
 * transparent so the ink shows through. Touches are routed here, once per gesture (see [InkRouter]): a view under the
 * WebView would never receive them through the normal dispatch.
 *
 * [send] carries lines back to the page (see [InkWire]); it is set by the bridge.
 */
class InkFrame(context: Context, private val webView: WebView, private val closedBackground: Int) : FrameLayout(context) {
	private val density = resources.displayMetrics.density
	private val layer = InkLayer(context)
	private var router = InkRouter()
	private var surface: InkRect? = null // device px, in this frame
	private var holes: List<InkRect> = emptyList() // device px
	var send: (String) -> Unit = {}
	val isOpen get() = surface != null

	init {
		layer.visibility = View.GONE
		layer.listener = object : InkLayerListener {
			override fun onStroke(stroke: InkWire.Stroke) = send(InkWire.strokeLine(stroke))
			override fun onErase(points: FloatArray) = send(InkWire.eraseLine(points))
		}
		addView(layer, LayoutParams(0, 0))
		addView(webView, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
	}

	/** Apply one line from the web. A failure shows the layer as unavailable (the web keeps its canvas). */
	fun apply(op: InkOp) {
		try {
			when (op) {
				is InkOp.Open -> open(op.rect)
				is InkOp.Close -> close()
				is InkOp.Holes -> holes = op.rects.map { px(it) }
				is InkOp.Tool -> layer.eraser = op.eraser
				is InkOp.Brush -> layer.setBrush(op.color, op.size)
				is InkOp.Sheet -> layer.setDark(op.dark)
				is InkOp.Strokes -> layer.finished.setStrokes(op.strokes)
				is InkOp.Kept -> layer.finished.setKept(op.strokes)
				is InkOp.View -> layer.setView(op.view)
				is InkOp.Ack -> layer.finished.ackPending()
			}
		} catch (e: RuntimeException) {
			close()
			send(InkWire.fallbackLine(e.message ?: e.javaClass.simpleName))
		}
	}

	private fun px(r: InkRect) = InkRect(r.x * density, r.y * density, r.w * density, r.h * density)

	private fun open(rectCss: InkRect) {
		val rect = px(rectCss)
		if (rect.w < 1f || rect.h < 1f) return
		// a re-open only moves the layer (the keyboard, a rotation): the router keeps what it has learned
		if (surface == null) router = InkRouter()
		surface = rect
		layer.layoutParams = LayoutParams(rect.w.toInt(), rect.h.toInt()).apply {
			leftMargin = rect.x.toInt()
			topMargin = rect.y.toInt()
		}
		layer.visibility = View.VISIBLE
		webView.setBackgroundColor(Color.TRANSPARENT)
	}

	private fun close() {
		surface = null
		holes = emptyList()
		layer.cancel(null)
		layer.visibility = View.GONE
		webView.setBackgroundColor(closedBackground)
	}

	override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
		val area = surface ?: return super.dispatchTouchEvent(ev)
		val pointers = (0 until ev.pointerCount).map { InkPointer(ev.getPointerId(it), ev.getX(it), ev.getY(it), ev.getToolType(it), ev.buttonState) }
		val action = when (ev.actionMasked) {
			MotionEvent.ACTION_DOWN -> InkAction.DOWN
			MotionEvent.ACTION_POINTER_DOWN -> InkAction.POINTER_DOWN
			MotionEvent.ACTION_MOVE -> InkAction.MOVE
			MotionEvent.ACTION_POINTER_UP -> InkAction.POINTER_UP
			MotionEvent.ACTION_UP -> InkAction.UP
			MotionEvent.ACTION_CANCEL -> InkAction.CANCEL
			else -> return true
		}
		val step = router.step(action, pointers, ev.actionIndex, area, holes)
		if (step.penSeenNow) send(InkWire.PEN_SEEN)
		if (step.cancelInk) layer.cancel(local(ev))
		when (step.route) {
			InkRoute.INK -> {
				val moved = local(ev)
				layer.handle(moved)
				moved.recycle()
			}
			InkRoute.WEB -> webView.dispatchTouchEvent(ev)
			InkRoute.PAN ->
				if (step.panDx != 0f || step.panDy != 0f || step.scale != 1f) {
					// two fingers: the web turns the midpoint's travel and the pinch into the new view
					send(InkWire.gestureLine(step.panDx / density, step.panDy / density, step.scale, (step.focusX - area.x) / density, (step.focusY - area.y) / density))
				}
			InkRoute.NONE -> {}
		}
		return true
	}

	/** A copy of the event in the layer's own coordinates. */
	private fun local(ev: MotionEvent): MotionEvent {
		val copy = MotionEvent.obtain(ev)
		copy.offsetLocation(-layer.left.toFloat(), -layer.top.toFloat())
		return copy
	}
}
