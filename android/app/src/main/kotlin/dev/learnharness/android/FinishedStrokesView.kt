package dev.learnharness.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RenderNode
import android.view.View
import androidx.ink.brush.Brush
import androidx.ink.brush.InputToolType
import androidx.ink.brush.StockBrushes
import androidx.ink.rendering.android.canvas.CanvasStrokeRenderer
import androidx.ink.strokes.MutableStrokeInputBatch
import androidx.ink.strokes.Stroke
import androidx.ink.strokes.StrokeInput
import java.util.Collections
import java.util.IdentityHashMap

/**
 * The finished strokes of the page, on the white page (the web canvas is always white): drawn with the renderer the
 * in-progress strokes use, so a stroke does not change look when it finishes. Strokes live in the canvas' page CSS px;
 * the view scales by the screen density and the infinite canvas's zoom and shifts by its origin (see [InkView]). [add] /
 * [clear] are the plain-stroke API the M9 spike uses.
 *
 * Cost model (owner, 2026-11-07: a dense page made pan, zoom, undo and every pen-down unusable). Each stroke is converted to ink
 * once, only when it is first on screen, and recorded once into a hardware display list (a [RenderNode]); a frame replays the
 * lists of the strokes that meet the view instead of building every mesh again, so pan costs by what is visible, not by the page.
 * A recording keeps the soft edge it was made at, so after a zoom the visible strokes are recorded again a few ms per frame
 * (progressive sharpening); during the gesture they are replayed scaled. A full `strokes` push reuses the ink and recordings of
 * every stroke whose content did not change ([StrokeKey]), so undo, redo and cut convert only what is new.
 */
class FinishedStrokesView(context: Context) : View(context) {
	/** What a stroke looks like, shared by every stroke with the same content: its ink, and its recording at the scale [nodeScale]. */
	private class Render(val source: InkWire.Stroke) {
		var ink: Stroke? = null
		var inkTone = -1
		var node: RenderNode? = null
		var nodeScale = 0f
		var nodeTone = -1
	}

	/** A stroke as ink draws it, with the wire stroke it came from (the eraser's fade is told which wire strokes it touches). */
	private class Drawn(val raw: InkWire.Stroke, val render: Render)

	private val renderer = CanvasStrokeRenderer.create()
	private val plain = ArrayList<Stroke>()
	private var strokes: List<Drawn> = emptyList()
	private var kept: List<Drawn> = emptyList()
	private var pending: List<Drawn> = emptyList()
	private var rawCache: List<InkWire.Stroke>? = null
	/** Bumped when the sheet's tone changes: every stroke's ink (its colours) and recording is then out of date. */
	private var toneGen = 0
	// ink and recordings by content, so a full push of mostly the same strokes does not convert them again (least recently used)
	private val pool = object : LinkedHashMap<StrokeKey, Render>(256, 0.75f, true) {
		override fun removeEldestEntry(eldest: MutableMap.MutableEntry<StrokeKey, Render>): Boolean {
			val drop = size > POOL_LIMIT
			if (drop) {
				eldest.value.node?.discardDisplayList()
				eldest.value.node = null
			}
			return drop
		}
	}
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
	private val recordMatrix = Matrix()
	private val identity = Matrix()
	private var density = 1f
	private var view = InkView()
	/** When the view last moved (nanoTime): while it keeps moving, recordings are replayed as they are, not made again. */
	private var viewMovedAt = 0L
	// the cached layer for a moving view (see [rebuildProxy]): the view it was made at, its margin (px), and whether it is current
	private var proxy: RenderNode? = null
	private var proxyView = InkView()
	private var proxyScale = 1f
	private var proxyMx = 0
	private var proxyMy = 0
	private var proxyBuilt = false
	private var proxyDirty = true
	/** The layer was made while strokes were still waiting to be recorded at this zoom: it is made again next frame. */
	private var proxyStale = false
	// this frame's state, read by [paint]: the page area to draw (page px), the screen scale, hardware canvas, moving view, frame start
	private var fx0 = 0f
	private var fy0 = 0f
	private var fx1 = 0f
	private var fy1 = 0f
	private var fScale = 1f
	private var fHardware = false
	private var fMoving = false
	private var fStart = 0L
	private var fRefine = false
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
		rawCache = null
		proxyDirty = true
		live = null
		faded = emptySet()
		clearTrail()
		invalidate()
	}

	/**
	 * Every wire stroke the eraser can reach, in the order the page numbers them: the working page (finished ones first, then the ones
	 * the web has not acknowledged yet), then the sent page (the kept strokes, drawn dimmed).
	 */
	fun allRaw(): List<InkWire.Stroke> {
		rawCache?.let { return it }
		val all = ArrayList<InkWire.Stroke>(strokes.size + pending.size + kept.size)
		for (d in strokes) all += d.raw
		for (d in pending) all += d.raw
		for (d in kept) all += d.raw
		rawCache = all
		return all
	}

	private fun renderOf(raw: InkWire.Stroke): Render = pool.getOrPut(StrokeKey(raw)) { Render(raw) }

	private fun drawnOf(list: List<InkWire.Stroke>): List<Drawn> = list.map { Drawn(it, renderOf(it)) }

	fun setStrokes(list: List<InkWire.Stroke>) {
		proxyDirty = true
		strokes = drawnOf(list)
		pending = emptyList() // the web's set now holds what we had drawn ahead of it
		rawCache = null
		clearTrail() // the page's answer to a part-eraser gesture is the new strokes: its cut replaces the trail
		invalidate()
	}

	fun setKept(list: List<InkWire.Stroke>) {
		proxyDirty = true
		kept = drawnOf(list)
		rawCache = null
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
		pending = pending + Drawn(stroke, renderOf(stroke))
		rawCache = null
		invalidate()
	}

	/**
	 * The web has the pending strokes in its store: they are part of the page now. They are drawn last either way, so nothing on
	 * the screen changes and nothing is redrawn (unless a trail ends with it).
	 */
	fun ackPending() {
		if (pending.isNotEmpty()) {
			strokes = strokes + pending
			pending = emptyList()
			proxyDirty = true // the layer holds the working strokes: the acknowledged one joins them
			rawCache = null // same order: working strokes, then none pending, then kept
		}
		clearTrail()
	}

	fun setView(v: InkView) {
		view = v
		viewMovedAt = System.nanoTime()
		invalidate()
	}

	/** The stroke held straight, shown until it is committed (null: none). */
	fun setLive(stroke: InkWire.Stroke?) {
		if (stroke == null && live == null) return // nothing to take off the screen: no redraw
		live = stroke?.let { toInk(it) }
		invalidate()
	}

	/**
	 * The stroke eraser's hits, gone now: dropped from what is shown without rebuilding the others (identity, from [allRaw]). The web
	 * then holds the same strokes, and its `ack` keeps this state; a full `strokes` push would replace it, as always.
	 */
	fun removeStrokes(gone: Set<InkWire.Stroke>) {
		if (gone.isEmpty()) return
		proxyDirty = true
		strokes = strokes.filter { it.raw !in gone }
		pending = pending.filter { it.raw !in gone }
		kept = kept.filter { it.raw !in gone }
		rawCache = null
		invalidate()
	}

	/** The wire strokes the stroke eraser is over (identity, from [allRaw]); empty when the gesture ends. */
	fun setFaded(strokes: Collection<InkWire.Stroke>) {
		val set = Collections.newSetFromMap(IdentityHashMap<InkWire.Stroke, Boolean>())
		set.addAll(strokes)
		if (set.size == faded.size && set.containsAll(faded)) return
		faded = set
		proxyDirty = true
		invalidate()
	}

	/** The sheet's tone: the paper and every stroke are shown in the tone's colours (see [InkSheet]). */
	fun setDark(on: Boolean) {
		if (dark == on) return
		dark = on
		paper = if (on) InkSheet.DARK_PAPER else InkSheet.LIGHT_PAPER
		toneGen++ // every stroke's ink and recording is made again, as it comes on screen
		proxyDirty = true
		invalidate()
	}

	/** This stroke's ink in the sheet's tone, converted the first time it is needed (null: ink cannot build it). */
	private fun inkOf(r: Render): Stroke? {
		if (r.inkTone != toneGen) {
			r.ink = toInk(r.source)
			r.inkTone = toneGen
		}
		return r.ink
	}

	/** Record the stroke into its display list at the screen scale [scale] (px per page px). */
	private fun record(r: Render, ink: Stroke, scale: Float) {
		val bounds = r.source.bounds ?: return
		val box = InkCull.nodeBox(bounds, r.source.size)
		val node = r.node ?: RenderNode("ink-stroke").also { r.node = it }
		node.setPosition(box[0], box[1], box[2], box[3])
		node.clipToBounds = false
		val canvas = node.beginRecording(box[2] - box[0], box[3] - box[1])
		try {
			canvas.translate(-box[0].toFloat(), -box[1].toFloat())
			// only the scale matters to the renderer: it sizes the soft edge from it (the page transform itself is on the canvas that replays)
			recordMatrix.setScale(scale, scale)
			renderer.draw(canvas, ink, recordMatrix)
		} finally {
			node.endRecording()
		}
		r.nodeScale = scale
		r.nodeTone = toneGen
	}

	/** Draw one stroke if it is on screen: its ink is made on first need, its recording replayed (made again when too far from the zoom). */
	private fun paint(canvas: Canvas, d: Drawn) {
		val raw = d.raw
		if (!InkCull.visible(raw.bounds, raw.size, fx0, fy0, fx1, fy1)) return
		val r = d.render
		val ink = inkOf(r) ?: return
		if (!fHardware) {
			renderer.draw(canvas, ink, matrix)
			return
		}
		// HWUI drops a display list when its node is left out of a frame (culled, erased, behind the layer): it must be recorded again
		val missing = r.node?.hasDisplayList() != true || r.nodeTone != toneGen
		val stale = !missing && InkCull.scaleStale(r.nodeScale, fScale)
		if (missing || (stale && !fMoving && System.nanoTime() - fStart < REFINE_BUDGET_NS)) record(r, ink, fScale)
		else if (stale) fRefine = true
		r.node?.let { canvas.drawRenderNode(it) }
	}

	/**
	 * The committed ink, in page px on a canvas that already has the page transform: the kept page and sent strokes dimmed, then the
	 * working strokes. What the eraser shows live (faded strokes, the pending stroke, the trail) is drawn over it, never in it.
	 * Sent ink is drawn dimmed: the kept page, and the sent strokes the web copied into the working page when the eraser first
	 * touched them (`sent`): only what is new, and the pieces left of what was cut, is drawn in full (as the web canvas does).
	 */
	private fun drawBase(canvas: Canvas) {
		val fade = faded
		if (kept.isNotEmpty() || strokes.any { it.raw.sent }) {
			val save = canvas.saveLayerAlpha(null, (KEPT_ALPHA * 255).toInt())
			for (d in kept) if (!fade.contains(d.raw)) paint(canvas, d)
			for (d in strokes) if (d.raw.sent && !fade.contains(d.raw)) paint(canvas, d)
			canvas.restoreToCount(save)
		}
		for (d in strokes) if (!d.raw.sent && !fade.contains(d.raw)) paint(canvas, d)
	}

	/** Can the cached layer stand in for the committed ink at this view? Not when the ink changed, the zoom moved far, or the view left it. */
	private fun proxyCovers(scale: Float): Boolean {
		if (!proxyBuilt || proxyDirty) return false
		val ps = proxyScale
		val ratio = scale / ps
		if (ratio < PROXY_RATIO_MIN || ratio > PROXY_RATIO_MAX) return false
		val cx0 = proxyView.x - proxyMx / ps
		val cy0 = proxyView.y - proxyMy / ps
		val cx1 = proxyView.x + (width + proxyMx) / ps
		val cy1 = proxyView.y + (height + proxyMy) / ps
		return fx0 >= cx0 && fy0 >= cy0 && fx1 <= cx1 && fy1 <= cy1
	}

	/**
	 * While the view moves, the committed ink is drawn into one GPU layer (the visible page plus a margin, at the current zoom) and
	 * that layer is only moved and scaled each frame: a frame then costs one textured quad, not a replay of every stroke (the
	 * RenderThread was 90% busy replaying 2900 recordings per frame, 120 times a second). It is made again when the view leaves it
	 * or the ink changes, and dropped when the view settles (the crisp, per-stroke drawing takes over).
	 */
	private fun rebuildProxy(scale: Float) {
		val mx = (width * PROXY_MARGIN).toInt()
		val my = (height * PROXY_MARGIN).toInt()
		val w = width + 2 * mx
		val h = height + 2 * my
		val node = proxy ?: RenderNode("ink-proxy").also { proxy = it }
		node.setPosition(0, 0, w, h)
		node.setUseCompositingLayer(true, null)
		// the area the layer covers, page px, for the cull in [paint]
		val sx0 = fx0
		val sy0 = fy0
		val sx1 = fx1
		val sy1 = fy1
		fx0 = view.x - mx / scale
		fy0 = view.y - my / scale
		fx1 = view.x + (width + mx) / scale
		fy1 = view.y + (height + my) / scale
		val rec = node.beginRecording(w, h)
		try {
			rec.translate(mx.toFloat(), my.toFloat())
			rec.concat(matrix)
			drawBase(rec)
		} finally {
			node.endRecording()
		}
		fx0 = sx0
		fy0 = sy0
		fx1 = sx1
		fy1 = sy1
		proxyView = view
		proxyScale = scale
		proxyMx = mx
		proxyMy = my
		proxyBuilt = true
		proxyDirty = false
	}

	/** The layer, placed and scaled from the view it was made at to the view now. */
	private fun drawProxy(canvas: Canvas, scale: Float) {
		val node = proxy ?: return
		val ps = proxyScale
		val ratio = scale / ps
		// the layer's top-left is at page (proxyView.x - margin / ps, …); that point is at ((x - view.x) * scale) on screen
		val ox = ((proxyView.x - proxyMx / ps) - view.x) * scale
		val oy = ((proxyView.y - proxyMy / ps) - view.y) * scale
		val save = canvas.save()
		canvas.translate(ox, oy)
		canvas.scale(ratio, ratio)
		canvas.drawRenderNode(node)
		canvas.restoreToCount(save)
	}

	private fun dropProxy() {
		proxy?.discardDisplayList()
		proxyBuilt = false
		proxyDirty = true
	}

	override fun onDetachedFromWindow() {
		super.onDetachedFromWindow()
		dropProxy()
	}

	override fun onVisibilityAggregated(isVisible: Boolean) {
		super.onVisibilityAggregated(isVisible)
		if (!isVisible) dropProxy() // the sketch view is closed: no texture is kept for it
	}

	override fun onDraw(canvas: Canvas) {
		val start = System.nanoTime()
		canvas.drawColor(paper)
		val scale = density * view.zoom
		matrix.setScale(scale, scale)
		matrix.postTranslate(-view.x * scale, -view.y * scale)
		// the part of the page on screen (page px): strokes that miss it are neither converted nor drawn
		fx0 = view.x
		fy0 = view.y
		fx1 = fx0 + width / scale
		fy1 = fy0 + height / scale
		fScale = scale
		fHardware = canvas.isHardwareAccelerated
		fMoving = start - viewMovedAt < MOVING_NS
		fStart = start
		fRefine = false
		val proxied = fHardware
		if (proxied) {
			// the layer is made again when the ink changed or the view left it; once the view is still, at exactly this view (so it is drawn
			// one-to-one, crisp) and again for as long as strokes are still being recorded at the new zoom
			val crisp = proxyBuilt && proxyView == view && !proxyStale
			if (!proxyCovers(scale) || (!fMoving && !crisp)) {
				rebuildProxy(scale)
				proxyStale = fRefine
			}
			drawProxy(canvas, scale)
		}
		// The page transform goes on the canvas (that is what PLACES the strokes: the renderer does not move them) AND is handed
		// to the renderer, which sizes its soft anti-aliasing edge from the stroke-to-screen transform it is given. Passing an
		// identity there while the canvas was scaled made every edge 1x-sized and then stretched: thick and blurry at zoom 459%
		// (found on the phone, 2026-10-29). Passing it WITHOUT scaling the canvas left the strokes at the same spot on the screen.
		val page = canvas.save()
		canvas.concat(matrix)
		val fade = faded
		if (!proxied) drawBase(canvas)
		for (d in pending) if (!fade.contains(d.raw)) paint(canvas, d)
		if (fade.isNotEmpty()) {
			// the strokes the stroke eraser is over fade until the gesture ends (the web canvas does the same)
			val save = canvas.saveLayerAlpha(null, (FADE_ALPHA * 255).toInt())
			for (d in kept) if (fade.contains(d.raw)) paint(canvas, d)
			for (d in strokes) if (fade.contains(d.raw)) paint(canvas, d)
			for (d in pending) if (fade.contains(d.raw)) paint(canvas, d)
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
		// recordings still at the old zoom: carry on next frame (after the gesture, when it is still moving)
		if (fRefine || proxyStale) {
			if (fMoving) postInvalidateDelayed(MOVING_NS / 1_000_000) else postInvalidateOnAnimation()
		}
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
		/** How many strokes' ink and recordings are kept by content (a page holds at most 3000, and undo brings some back). */
		const val POOL_LIMIT = 4000
		/** The view counts as moving until it has been still this long; recordings are not made again meanwhile. */
		const val MOVING_NS = 140_000_000L
		/** The most a frame spends recording strokes again after a zoom (the rest wait for the next frame). */
		const val REFINE_BUDGET_NS = 5_000_000L
		/** The moving-view layer covers the screen plus this share of its size on each side. */
		const val PROXY_MARGIN = 0.25f
		/** The layer stands in only while the zoom is within this range of the zoom it was made at. */
		const val PROXY_RATIO_MIN = 0.7f
		const val PROXY_RATIO_MAX = 1.45f
	}
}
