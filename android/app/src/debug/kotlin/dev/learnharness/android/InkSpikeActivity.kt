package dev.learnharness.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.ink.authoring.InProgressStrokeId
import androidx.ink.authoring.InProgressStrokesFinishedListener
import androidx.ink.authoring.InProgressStrokesView
import androidx.ink.brush.Brush
import androidx.ink.brush.StockBrushes
import androidx.ink.rendering.android.canvas.CanvasStrokeRenderer
import androidx.ink.strokes.Stroke
import androidx.input.motionprediction.MotionEventPredictor

/**
 * The M9 spike: the smallest native ink screen (androidx.ink's front-buffered InProgressStrokesView, with
 * motion prediction) to film next to the WebView's sketch canvas. Every touch/pen move logs how long the
 * event waited before the app saw it (`uptimeMillis - eventTime`), the same stage the web probe measures
 * (`scripts/ink-latency.mjs probe`). Debug builds only; start it with
 * `adb shell am start -n dev.learnharness.android/.InkSpikeActivity`.
 */
class InkSpikeActivity : ComponentActivity() {
	private lateinit var inProgress: InProgressStrokesView
	private lateinit var finished: FinishedStrokesView
	private lateinit var stats: TextView
	private lateinit var predictor: MotionEventPredictor
	private val strokes = HashMap<Int, InProgressStrokeId>()
	private val dispatchMs = ArrayList<Float>()
	private var predictionOn = true

	private val brush by lazy {
		Brush.createWithColorIntArgb(StockBrushes.pressurePen(), Color.WHITE, 3f, 0.1f)
	}

	override fun onCreate(savedInstanceState: Bundle?) {
		enableEdgeToEdge()
		super.onCreate(savedInstanceState)
		val root = FrameLayout(this).apply { setBackgroundColor(0xFF141414.toInt()) }
		finished = FinishedStrokesView(this)
		inProgress = InProgressStrokesView(this)
		predictor = MotionEventPredictor.newInstance(inProgress)
		inProgress.addFinishedStrokesListener(object : InProgressStrokesFinishedListener {
			override fun onStrokesFinished(strokes: Map<InProgressStrokeId, Stroke>) {
				finished.add(strokes.values)
				inProgress.removeFinishedStrokes(strokes.keys)
			}
		})
		inProgress.setOnTouchListener { view, event -> onTouch(view, event) }

		stats = TextView(this).apply { setTextColor(0xFFB0B0B0.toInt()); setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f); text = "draw here" }
		val clear = Button(this).apply { text = "Clear"; setOnClickListener { finished.clear(); dispatchMs.clear(); stats.text = "cleared" } }
		val prediction = Button(this).apply {
			text = "Prediction: on"
			setOnClickListener { predictionOn = !predictionOn; text = "Prediction: ${if (predictionOn) "on" else "off"}" }
		}
		val bar = LinearLayout(this).apply {
			orientation = LinearLayout.HORIZONTAL
			gravity = Gravity.CENTER_VERTICAL
			setPadding(24, 120, 24, 8)
			addView(clear)
			addView(prediction)
			addView(stats)
		}
		val match = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
		root.addView(finished, match)
		root.addView(inProgress, match)
		root.addView(bar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
		setContentView(root)
	}

	private fun onTouch(view: View, event: MotionEvent): Boolean {
		when (event.actionMasked) {
			MotionEvent.ACTION_DOWN -> {
				view.requestUnbufferedDispatch(event)
				val pointer = event.getPointerId(0)
				strokes[pointer] = inProgress.startStroke(event, pointer, brush)
				predictor.record(event)
			}
			MotionEvent.ACTION_MOVE -> {
				dispatchMs += (SystemClock.uptimeMillis() - event.eventTime).toFloat()
				predictor.record(event)
				val predicted = if (predictionOn) predictor.predict() else null
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
		val text = "moves=${sorted.size} dispatch ms: median=${"%.1f".format(sorted[sorted.size / 2])} p90=${"%.1f".format(sorted[(sorted.size * 9) / 10])} max=${"%.1f".format(sorted.last())}"
		stats.text = text
		Log.i("InkSpike", text)
	}
}
