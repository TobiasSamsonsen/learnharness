package dev.learnharness.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.View
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * The angle guide while a held line is drawn near another straight line (see [InkAngle]): a thin arc between the two lines
 * and a whole-degree label just outside it, in the pen's colour at 60 percent. Shown from the hold until the pen lifts.
 * It sits above the strokes and never takes touches.
 */
class AngleOverlay(context: Context) : View(context) {
	private val density = resources.displayMetrics.density
	private val arcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
		style = Paint.Style.STROKE
		strokeWidth = 1.5f * density
		strokeCap = Paint.Cap.ROUND
	}
	private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
		style = Paint.Style.FILL
		textAlign = Paint.Align.CENTER
		textSize = 14f * density
	}
	private val oval = RectF()
	private var guide: InkAngle.Guide? = null
	private var cx = 0f
	private var cy = 0f
	private var label = ""

	init {
		isClickable = false
		isFocusable = false
	}

	/** Show the guide with its vertex at (x, y) in this view's px, in [color] (ARGB), or hide it (null). */
	fun show(g: InkAngle.Guide?, x: Float, y: Float, color: Int) {
		if (g == null && guide == null) return
		guide = g
		cx = x
		cy = y
		if (g != null) {
			label = "${g.degrees}°"
			val tinted = (color and 0x00FFFFFF) or (ALPHA shl 24)
			arcPaint.color = tinted
			textPaint.color = tinted
		}
		invalidate()
	}

	override fun onDraw(canvas: Canvas) {
		val g = guide ?: return
		val r = (g.radiusPx * density).toFloat()
		oval.set(cx - r, cy - r, cx + r, cy + r)
		canvas.drawArc(oval, g.from.toFloat(), g.sweep.toFloat(), false, arcPaint)
		val mid = (g.from + g.sweep / 2) * PI / 180.0
		val out = r + LABEL_GAP_DP * density
		val tx = cx + (cos(mid) * out).toFloat()
		val ty = cy + (sin(mid) * out).toFloat() - (textPaint.ascent() + textPaint.descent()) / 2f
		canvas.drawText(label, tx, ty, textPaint)
	}

	private companion object {
		/** 60 percent of 255. */
		const val ALPHA = 153
		/** The label's centre sits this far outside the arc. */
		const val LABEL_GAP_DP = 14f
	}
}
