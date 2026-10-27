package dev.learnharness.android

import java.util.Locale

/**
 * The native-ink bridge, pure parts (Android plan M10, docs/android/m10-plan.md): the lines the web sends
 * (`src/core/ink-bridge.ts` writes them), the rule that decides who gets a touch, and the JSON the shell answers an
 * export with (an array of `SketchStroke`, `src/core/contracts/sketch.ts`). No Android types, so `./gradlew test`
 * covers it; the overlay view that uses it is built only if the M9 decision says so.
 */

data class InkRect(val x: Float, val y: Float, val w: Float, val h: Float) {
	fun contains(px: Float, py: Float): Boolean = px >= x && px <= x + w && py >= y && py <= y + h
}

sealed interface InkOp {
	data class Open(val inkKey: String, val rect: InkRect) : InkOp
	data class Holes(val rects: List<InkRect>) : InkOp
	data class Tool(val eraser: Boolean) : InkOp
	data object Undo : InkOp
	data object Redo : InkOp
	data object Clear : InkOp
	data object Close : InkOp
	data object Export : InkOp
}

object InkWire {
	private val key = Regex("[A-Za-z0-9_-]{1,80}")

	/** One line from the web, or null when it is not one the shell understands (never throws). */
	fun parse(line: String): InkOp? {
		val parts = line.trim().split(Regex("\\s+"))
		return when (parts.firstOrNull()) {
			"open" -> {
				if (parts.size != 6 || !key.matches(parts[1])) return null
				val n = parts.drop(2).map { it.toFloatOrNull() ?: return null }
				InkOp.Open(parts[1], InkRect(n[0], n[1], n[2], n[3]))
			}
			"holes" -> InkOp.Holes(parts.drop(1).map { rect(it) ?: return null })
			"tool" -> when (parts.getOrNull(1)) {
				"pen" -> InkOp.Tool(eraser = false)
				"eraser" -> InkOp.Tool(eraser = true)
				else -> null
			}
			"undo" -> if (parts.size == 1) InkOp.Undo else null
			"redo" -> if (parts.size == 1) InkOp.Redo else null
			"clear" -> if (parts.size == 1) InkOp.Clear else null
			"close" -> if (parts.size == 1) InkOp.Close else null
			"export" -> if (parts.size == 1) InkOp.Export else null
			else -> null
		}
	}

	private fun rect(text: String): InkRect? {
		val n = text.split(",").map { it.toFloatOrNull() ?: return null }
		return if (n.size == 4) InkRect(n[0], n[1], n[2], n[3]) else null
	}

	/** One exported stroke: base size in CSS px, an optional #rrggbb, flat [x, y, pressure, …]. */
	class Stroke(val size: Float, val color: String?, val points: FloatArray)

	/** The `SketchStroke[]` JSON the web validates with the same rules as a web sketch. Locale-independent. */
	fun strokesJson(strokes: List<Stroke>): String {
		fun n(v: Float) = String.format(Locale.ROOT, "%.2f", v).trimEnd('0').trimEnd('.').ifEmpty { "0" }
		return strokes.joinToString(prefix = "[", postfix = "]", separator = ",") { s ->
			val color = if (s.color != null) ",\"color\":\"${s.color}\"" else ""
			"{\"size\":${n(s.size)}$color,\"points\":[${s.points.joinToString(",") { n(it) }}]}"
		}
	}
}

enum class InkTarget { INK, WEB }

object InkRouting {
	const val TOOL_TYPE_STYLUS = 2
	const val TOOL_TYPE_ERASER = 4

	/**
	 * Who gets a touch while the native surface is open: the pen (its tip or its eraser end) goes to the ink layer
	 * unless it lands on a hole (the floating question box and other web UI over the canvas); fingers and everything
	 * else always go to the WebView, which pans and taps. A stroke keeps its target from ACTION_DOWN to the end
	 * (the caller decides once, on DOWN).
	 */
	fun route(toolType: Int, x: Float, y: Float, surface: InkRect?, holes: List<InkRect>): InkTarget {
		if (surface == null || !surface.contains(x, y)) return InkTarget.WEB
		val pen = toolType == TOOL_TYPE_STYLUS || toolType == TOOL_TYPE_ERASER
		if (!pen) return InkTarget.WEB
		return if (holes.any { it.contains(x, y) }) InkTarget.WEB else InkTarget.INK
	}
}
