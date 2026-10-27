package dev.learnharness.android

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.RectF
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.ink.authoring.InProgressStrokeId
import androidx.ink.authoring.InProgressStrokesFinishedListener
import androidx.ink.authoring.InProgressStrokesView
import androidx.ink.brush.Brush
import androidx.ink.brush.StockBrushes
import androidx.ink.strokes.Stroke
import androidx.input.motionprediction.MotionEventPredictor
import org.json.JSONArray

/**
 * M10 step 0, the layering spike (docs/android/m10-plan.md): androidx.ink's front-buffered
 * InProgressStrokesView UNDER a transparent WebView. Questions it answers on the device:
 * does ink show through the transparent page, do DOM elements (a toolbar, a floating box) stay above
 * and clickable, does region routing work (touches in a DOM "hole" go to the WebView, the rest to ink),
 * does the line still stay under the stylus, and which tool type does the owner's capacitive stylus report.
 * Debug builds only: `adb shell am start -n dev.learnharness.android/.InkLayerSpikeActivity`.
 * Logcat tag `InkLayerSpike`: tool type per DOWN, dispatch ms per stroke, DOM clicks, hole rects.
 */
class InkLayerSpikeActivity : ComponentActivity() {
	private lateinit var frame: RoutingFrame
	private lateinit var inProgress: InProgressStrokesView
	private lateinit var finished: FinishedStrokesView
	private lateinit var webView: WebView
	private lateinit var status: TextView
	private lateinit var predictor: MotionEventPredictor
	private val strokes = HashMap<Int, InProgressStrokeId>()
	private val dispatchMs = ArrayList<Float>()
	private var density = 1f

	private val brush by lazy {
		Brush.createWithColorIntArgb(StockBrushes.pressurePen(), 0xFF111111.toInt(), 4f * density, 0.1f)
	}

	@SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
	override fun onCreate(savedInstanceState: Bundle?) {
		enableEdgeToEdge()
		super.onCreate(savedInstanceState)
		density = resources.displayMetrics.density
		frame = RoutingFrame(this).apply { setBackgroundColor(Color.WHITE) }

		finished = FinishedStrokesView(this)
		inProgress = InProgressStrokesView(this)
		predictor = MotionEventPredictor.newInstance(inProgress)
		inProgress.addFinishedStrokesListener(object : InProgressStrokesFinishedListener {
			override fun onStrokesFinished(strokes: Map<InProgressStrokeId, Stroke>) {
				finished.add(strokes.values)
				inProgress.removeFinishedStrokes(strokes.keys)
			}
		})
		inProgress.setOnTouchListener { view, event -> onInkTouch(view, event) }

		webView = WebView(this).apply {
			setBackgroundColor(Color.TRANSPARENT)
			settings.javaScriptEnabled = true
			addJavascriptInterface(Probe(), "Probe")
		}
		status = TextView(this).apply {
			setTextColor(0xFF444444.toInt())
			setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
			setPadding(24, 0, 24, 24)
			gravity = Gravity.BOTTOM
			text = "ink region: everything outside the toolbar and the box"
		}
		val match = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
		frame.ink = inProgress
		frame.web = webView
		frame.addView(finished, match)
		frame.addView(inProgress, match)
		frame.addView(webView, match)
		frame.addView(status, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
		setContentView(frame)
		webView.loadDataWithBaseURL("https://spike.invalid/", PAGE, "text/html", "utf-8", null)
	}

	private fun onInkTouch(view: View, event: MotionEvent): Boolean {
		when (event.actionMasked) {
			MotionEvent.ACTION_DOWN -> {
				view.requestUnbufferedDispatch(event)
				val pointer = event.getPointerId(0)
				Log.i("InkLayerSpike", "down tool=${event.getToolType(0)} (1=finger 2=stylus 4=eraser) buttons=${event.buttonState}")
				strokes[pointer] = inProgress.startStroke(event, pointer, brush)
				predictor.record(event)
			}
			MotionEvent.ACTION_MOVE -> {
				dispatchMs += (SystemClock.uptimeMillis() - event.eventTime).toFloat()
				predictor.record(event)
				val predicted = predictor.predict()
				for (i in 0 until event.pointerCount) {
					val pointer = event.getPointerId(i)
					val id = strokes[pointer] ?: continue
					inProgress.addToStroke(event, pointer, id, predicted)
				}
				predicted?.recycle()
			}
			MotionEvent.ACTION_UP -> {
				val pointer = event.getPointerId(event.actionIndex)
				strokes.remove(pointer)?.let { inProgress.finishStroke(event, pointer, it) }
				report()
			}
			MotionEvent.ACTION_CANCEL -> {
				val pointer = event.getPointerId(event.actionIndex)
				strokes.remove(pointer)?.let { inProgress.cancelStroke(it, event) }
			}
		}
		return true
	}

	private fun report() {
		if (dispatchMs.isEmpty()) return
		val sorted = dispatchMs.sorted()
		val text = "ink moves=${sorted.size} dispatch ms: median=${"%.1f".format(sorted[sorted.size / 2])} p90=${"%.1f".format(sorted[(sorted.size * 9) / 10])} max=${"%.1f".format(sorted.last())}"
		runOnUiThread { status.text = text }
		Log.i("InkLayerSpike", text)
		dispatchMs.clear()
	}

	/** The page reports its "hole" elements (CSS px); the activity turns them into device px for the routing. */
	private inner class Probe {
		@JavascriptInterface
		fun holes(json: String) {
			val array = JSONArray(json)
			val rects = (0 until array.length()).map {
				val r = array.getJSONArray(it)
				RectF(
					(r.getDouble(0) * density).toFloat(),
					(r.getDouble(1) * density).toFloat(),
					((r.getDouble(0) + r.getDouble(2)) * density).toFloat(),
					((r.getDouble(1) + r.getDouble(3)) * density).toFloat(),
				)
			}
			frame.holes = rects
			Log.i("InkLayerSpike", "holes=$json px=${rects.joinToString { "[${it.left.toInt()},${it.top.toInt()},${it.right.toInt()},${it.bottom.toInt()}]" }}")
		}

		@JavascriptInterface
		fun clicked(name: String) {
			Log.i("InkLayerSpike", "dom click: $name")
			runOnUiThread { status.text = "dom click: $name" }
		}
	}

	companion object {
		private const val PAGE = """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>
html,body{margin:0;background:transparent;font-family:sans-serif}
#bar{position:fixed;top:56px;left:0;right:0;height:72px;display:flex;gap:12px;align-items:center;padding:0 12px;background:#f3f3f3;border-bottom:1px solid #999}
#box{position:fixed;left:24px;top:300px;width:280px;height:150px;background:#fff;border:2px solid #444;border-radius:12px;padding:12px;box-shadow:0 4px 16px rgba(0,0,0,.35)}
button{font-size:18px;padding:12px 16px}
</style></head><body>
<div id="bar" class="hole"><button id="b1">toolbar tap (0)</button><span>page is transparent</span></div>
<div id="box" class="hole"><div>floating box: DOM above the ink</div><button id="b2">box tap (0)</button></div>
<script>
var n={b1:0,b2:0};
for (var id in n) (function(id){document.getElementById(id).addEventListener('click',function(){n[id]++;this.textContent=(id=='b1'?'toolbar':'box')+' tap ('+n[id]+')';Probe.clicked(id);});})(id);
function rects(){return JSON.stringify([].map.call(document.querySelectorAll('.hole'),function(e){var r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height];}));}
Probe.holes(rects());
window.addEventListener('resize',function(){Probe.holes(rects());});
</script></body></html>"""
	}
}

/**
 * Routes each gesture ONCE, on its DOWN: inside a hole rect to the WebView, everywhere else to the ink view.
 * A view under the WebView never receives touches through the normal dispatch, so this frame dispatches
 * straight to the chosen child and never calls super.
 */
class RoutingFrame(context: android.content.Context) : FrameLayout(context) {
	var holes: List<RectF> = emptyList()
	var ink: View? = null
	var web: View? = null
	private var target: View? = null

	override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
		if (ev.actionMasked == MotionEvent.ACTION_DOWN) {
			target = if (holes.any { it.contains(ev.x, ev.y) }) web else ink
		}
		val chosen = target ?: return false
		val handled = chosen.dispatchTouchEvent(ev)
		if (ev.actionMasked == MotionEvent.ACTION_UP || ev.actionMasked == MotionEvent.ACTION_CANCEL) target = null
		return handled
	}
}
