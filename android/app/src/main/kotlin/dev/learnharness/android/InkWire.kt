package dev.learnharness.android

import java.util.Locale
import org.json.JSONArray
import org.json.JSONException

/**
 * The native-ink bridge, pure parts (Android plan M10, docs/android/m10-plan.md). The web store owns the strokes
 * (owner decision B, 2026-10-27): the shell draws, reports each finished stroke and eraser gesture, and the web pushes
 * the finished set back. Lines the web sends (`src/core/ink-bridge.ts` writes them): `open`, `holes`, `tool`,
 * `brush`, `strokes`, `kept`, `scroll`, `ack`, `close`. Lines the shell sends back: `stroke`, `erase`, `pan`, `penseen`, `fallback`.
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
	/** The pen's colour (#rrggbb) and base size in CSS px: the strokes drawn from now on use it. */
	data class Brush(val color: String, val size: Float) : InkOp
	/** The finished strokes of the page being written (page CSS px). */
	data class Strokes(val strokes: List<InkWire.Stroke>) : InkOp
	/** Strokes already sent to the tutor: drawn faint, like the web canvas. */
	data class Kept(val strokes: List<InkWire.Stroke>) : InkOp
	/** The canvas' scroll offset in CSS px. */
	data class Scroll(val y: Float) : InkOp
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
			"brush" -> {
				val parts = rest.split(Regex("\\s+"))
				if (parts.size != 2 || !Regex("#[0-9a-fA-F]{6}").matches(parts[0])) return null
				val size = finite(parts[1])?.takeIf { it in 0.5f..64f } ?: return null
				InkOp.Brush(parts[0], size)
			}
			"strokes" -> InkOp.Strokes(strokes(rest) ?: return null)
			"kept" -> InkOp.Kept(strokes(rest) ?: return null)
			"scroll" -> InkOp.Scroll(finite(rest) ?: return null)
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

	/** An eraser gesture: flat [x, y, …] in the canvas' page CSS px. The web decides which strokes it hit. */
	fun eraseLine(points: FloatArray) = "erase ${points.joinToString(",") { n(if (it.isFinite()) it else 0f) }}"

	/** Two fingers moved: scroll the canvas by this many CSS px (positive = further down the page). */
	fun panLine(dy: Float) = "pan ${n(dy)}"

	/** The native layer cannot be shown: the web keeps its own canvas. */
	fun fallbackLine(reason: String) = "fallback ${reason.replace(Regex("\\s+"), " ").take(120)}"
}
