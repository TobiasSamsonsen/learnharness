package dev.learnharness.android

import java.util.Locale
import org.json.JSONArray
import org.json.JSONException

/**
 * The native-ink bridge, pure parts (Android plan M10, docs/android/m10-plan.md). The web store owns the strokes
 * (owner decision B, 2026-10-27): the shell draws, reports each finished stroke and eraser gesture, and the web pushes
 * the finished set back. Lines the web sends (`src/core/ink-bridge.ts` writes them): `open`, `holes`, `tool`,
 * `eraser`, `brush`, `sheet`, `strokes`, `kept`, `view`, `ack`, `close`. Lines the shell sends back: `stroke`, `erase`, `gesture`, `penseen`, `fallback`.
 * No Android types except org.json, so `./gradlew test` covers it.
 */

data class InkRect(val x: Float, val y: Float, val w: Float, val h: Float) {
	fun contains(px: Float, py: Float): Boolean = px >= x && px <= x + w && py >= y && py <= y + h
}

sealed interface InkOp {
	/** The canvas rectangle, in CSS px of the page's viewport; the ink layer sits exactly there. */
	data class Open(val inkKey: String, val rect: InkRect) : InkOp
	/** Web UI over the canvas (the floating question box, its collapsed pill): touches there stay with the page. */
	data class Holes(val rects: List<InkRect>) : InkOp
	data class Tool(val eraser: Boolean) : InkOp
	/** The eraser's mode and reach (M16): in stroke mode the shell fades the strokes the eraser is over while it runs; [radius] is CSS px on screen. */
	data class Eraser(val strokeMode: Boolean, val radius: Float) : InkOp
	/** The sheet's tone (M13): a dark sheet shows ink in lighter variants. A display choice; the strokes are unchanged. */
	data class Sheet(val dark: Boolean) : InkOp
	/** The pen's colour (#rrggbb) and base size in CSS px: the strokes drawn from now on use it. */
	data class Brush(val color: String, val size: Float) : InkOp
	/** The finished strokes of the page being written (page CSS px). */
	data class Strokes(val strokes: List<InkWire.Stroke>) : InkOp
	/** Strokes already sent to the tutor: drawn faint, like the web canvas. */
	data class Kept(val strokes: List<InkWire.Stroke>) : InkOp
	/** The infinite canvas's view (M13c): zoom and the world position of the layer's top-left corner. */
	data class View(val view: InkView) : InkOp
	/** The stroke the shell just reported is in the web's store: keep it as drawn (no full push needed). */
	data object Ack : InkOp
	data object Close : InkOp
}

object InkWire {
	private val key = Regex("[A-Za-z0-9_-]{1,80}")

	/** One line from the web, or null when it is not one the shell understands (never throws). */
	fun parse(line: String): InkOp? {
		val text = line.trim()
		val verb = text.substringBefore(' ')
		val rest = text.substringAfter(' ', "").trim()
		return when (verb) {
			"open" -> {
				val parts = rest.split(Regex("\\s+"))
				if (parts.size != 5 || !key.matches(parts[0])) return null
				val n = parts.drop(1).map { finite(it) ?: return null }
				InkOp.Open(parts[0], InkRect(n[0], n[1], n[2], n[3]))
			}
			"holes" -> InkOp.Holes(rest.split(Regex("\\s+")).filter { it.isNotEmpty() }.map { rect(it) ?: return null })
			"tool" -> when (rest) {
				"pen" -> InkOp.Tool(eraser = false)
				"eraser" -> InkOp.Tool(eraser = true)
				else -> null
			}
			"eraser" -> {
			val parts = rest.split(Regex("\\s+"))
			if (parts.size != 2) return null
			val strokeMode = when (parts[0]) {
			"stroke" -> true
			"pixel" -> false
			else -> return null
			}
			val radius = finite(parts[1])?.takeIf { it in 1f..200f } ?: return null
			InkOp.Eraser(strokeMode, radius)
			}
			"brush" -> {
			val parts = rest.split(Regex("\\s+"))
				if (parts.size != 2 || !Regex("#[0-9a-fA-F]{6}").matches(parts[0])) return null
				val size = finite(parts[1])?.takeIf { it in 0.5f..64f } ?: return null
				InkOp.Brush(parts[0], size)
			}
			"sheet" -> when (rest) {
				"dark" -> InkOp.Sheet(dark = true)
				"light" -> InkOp.Sheet(dark = false)
				else -> null
			}
			"strokes" -> InkOp.Strokes(strokes(rest) ?: return null)
			"kept" -> InkOp.Kept(strokes(rest) ?: return null)
			"view" -> {
				val parts = rest.split(Regex("\\s+"))
				if (parts.size != 3) return null
				InkOp.View(InkView.parse(finite(parts[0]), finite(parts[1]), finite(parts[2])) ?: return null)
			}
			"ack" -> if (rest.isEmpty()) InkOp.Ack else null
			"close" -> if (rest.isEmpty()) InkOp.Close else null
			else -> null
		}
	}

	private fun finite(text: String): Float? = text.toFloatOrNull()?.takeIf { it.isFinite() }

	private fun rect(text: String): InkRect? {
		val n = text.split(",").map { finite(it) ?: return null }
		return if (n.size == 4) InkRect(n[0], n[1], n[2], n[3]) else null
	}

	/** A stroke: base size in CSS px, an optional #rrggbb, flat [x, y, pressure, …] in the canvas' page CSS px. */
	class Stroke(val size: Float, val color: String?, val points: FloatArray)

	/** The `SketchStroke[]` JSON from the web, or null when any part of it is malformed (never throws). */
	fun strokes(json: String): List<Stroke>? = try {
		val array = JSONArray(json)
		(0 until array.length()).map { i ->
			val o = array.getJSONObject(i)
			val raw = o.getJSONArray("points")
			if (raw.length() % 3 != 0) return null
			val points = FloatArray(raw.length()) { k ->
				val v = raw.getDouble(k).toFloat()
				if (!v.isFinite()) return null
				v
			}
			val size = o.getDouble("size").toFloat()
			if (!size.isFinite() || size <= 0f) return null
			val color = o.optString("color", "").takeIf { Regex("#[0-9a-fA-F]{6}").matches(it) }
			Stroke(size, color, points)
		}
	} catch (_: JSONException) {
		null
	}

	private fun n(v: Float) = String.format(Locale.ROOT, "%.2f", v).trimEnd('0').trimEnd('.').ifEmpty { "0" }

	/** The `SketchStroke[]` JSON the web validates with the same rules as a web sketch. Locale-independent. */
	fun strokesJson(strokes: List<Stroke>): String =
		strokes.joinToString(prefix = "[", postfix = "]", separator = ",") { s ->
			val color = if (s.color != null) ",\"color\":\"${s.color}\"" else ""
			"{\"size\":${n(s.size)}$color,\"points\":[${s.points.joinToString(",") { n(if (it.isFinite()) it else 0f) }}]}"
		}

	// ── shell → web ──────────────────────────────────────────────────────────

	const val PEN_SEEN = "penseen"

	/** One finished stroke. */
	fun strokeLine(s: Stroke) = "stroke ${strokesJson(listOf(s))}"

	/** The x, y of flat [x, y, pressure, …] triples, as flat [x, y, …] (the layer records triples; the erase line is pairs). */
	fun xyOf(triples: FloatArray): FloatArray {
		val count = triples.size / 3
		return FloatArray(count * 2) { k -> triples[(k / 2) * 3 + k % 2] }
	}

	/** Does the eraser point (x, y) with reach r touch this stroke? Mirrors src/core/sketch.ts sketchStrokeHit. */
		fun strokeHit(s: Stroke, x: Float, y: Float, r: Float): Boolean {
			val p = s.points
			if (p.size < 3) return false
			val reach = r + s.size / 2f
			var px = p[0]
			var py = p[1]
			if (kotlin.math.hypot((x - px).toDouble(), (y - py).toDouble()) <= reach) return true
			var k = 3
			while (k + 1 < p.size) {
				val qx = p[k]
				val qy = p[k + 1]
				val dx = qx - px
				val dy = qy - py
				val len2 = dx * dx + dy * dy
				val t = if (len2 == 0f) 0f else (((x - px) * dx + (y - py) * dy) / len2).coerceIn(0f, 1f)
				if (kotlin.math.hypot((x - (px + t * dx)).toDouble(), (y - (py + t * dy)).toDouble()) <= reach) return true
				px = qx
				py = qy
				k += 3
			}
			return false
		}

		/**
		 * The indexes of the strokes the eraser path ([xy]: flat [x, y, …], from point [fromPair] on) touched, by the same rule the
		 * web applies when the gesture ends (src/core/ink-bridge.ts eraseHits). The layer uses it to fade them while the gesture runs.
		 */
		fun eraseHits(strokes: List<Stroke>, xy: FloatArray, radius: Float, fromPair: Int = 0): Set<Int> {
			val hits = LinkedHashSet<Int>()
			strokes.forEachIndexed { index, stroke ->
				var k = fromPair * 2
				while (k + 1 < xy.size) {
					if (strokeHit(stroke, xy[k], xy[k + 1], radius)) {
						hits += index
						break
					}
					k += 2
				}
			}
			return hits
		}

		/** An eraser gesture: flat [x, y, …] in the canvas' page CSS px. The web decides which strokes it hit. */
	fun eraseLine(points: FloatArray) = "erase ${points.joinToString(",") { n(if (it.isFinite()) it else 0f) }}"

	/**
	 * Two fingers moved: their midpoint travelled (dx, dy) CSS px, the distance between them changed by [scale] (1 = no
	 * pinch), and the midpoint is now at (fx, fy) CSS px from the layer's top-left. The web turns it into a new view.
	 */
	fun gestureLine(dx: Float, dy: Float, scale: Float, fx: Float, fy: Float) =
		"gesture ${n(dx)} ${n(dy)} ${String.format(Locale.ROOT, "%.4f", if (scale.isFinite() && scale > 0f) scale else 1f)} ${n(fx)} ${n(fy)}"

	/** The native layer cannot be shown: the web keeps its own canvas. */
	fun fallbackLine(reason: String) = "fallback ${reason.replace(Regex("\\s+"), " ").take(120)}"
}
