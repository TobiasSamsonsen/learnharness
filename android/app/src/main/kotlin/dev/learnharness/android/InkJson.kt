package dev.learnharness.android

/**
 * A fast reader for the one JSON the page sends in `strokes` / `kept` lines: `[{"size":4,"color":"#rrggbb","points":[x,y,p,…],
 * "fresh":false},…]` as `JSON.stringify` writes it. org.json built a boxed value per number and took about 520 ms for a 2 MB page of
 * 2900 strokes, on the UI thread, per undo, redo and cut (measured on the phone, 2026-11-07). This reads the numbers straight off the
 * string. It is only a shortcut: anything it does not recognise or that breaks a rule (an unknown key, an odd number of
 * coordinates, a non-finite number, a bad size) makes it return null and [InkWire.strokes] falls back to the general reader, which
 * decides what such a line means. No Android types, so `./gradlew test` covers it.
 */
internal object InkJson {
	private class NotMine : RuntimeException(null, null, false, false)

	/** The strokes of [json], or null when it is not the plain shape above (the caller then uses the general parser). */
	fun strokes(json: String): List<InkWire.Stroke>? = try {
		Reader(json).strokes()
	} catch (_: NotMine) {
		null
	}

	private val hexColor = Regex("#[0-9a-fA-F]{6}")
	private val POW10 = DoubleArray(23).also { var p = 1.0; for (i in it.indices) { it[i] = p; p *= 10.0 } }

	private class Reader(json: String) {
		// chars in an array: no bounds-checked charAt per character on the hot path
		private val s: CharArray = json.toCharArray()
		private val len = s.size
		private var i = 0

		private fun no(): Nothing = throw NotMine()

		private fun word(w: String): Boolean {
			if (i + w.length > len) return false
			for (k in w.indices) if (s[i + k] != w[k]) return false
			return true
		}

		private fun skip() {
			while (i < len && s[i] <= ' ') i++
		}

		private fun take(c: Char) {
			skip()
			if (i >= len || s[i] != c) no()
			i++
		}

		private fun peek(): Char {
			skip()
			return if (i < len) s[i] else '\u0000'
		}

		/** `"…"` with no escapes (a colour or a key). */
		private fun string(): String {
			take('"')
			val from = i
			while (i < len && s[i] != '"') {
				if (s[i] == '\\') no()
				i++
			}
			if (i >= len) no()
			val out = String(s, from, i - from)
			i++
			return out
		}

		/** A JSON number, as org.json would read it (a double) and then the page's `toFloat()`. */
		private fun number(): Float {
			skip()
			val start = i
			var neg = false
			if (i < len && s[i] == '-') {
				neg = true
				i++
			}
			var mant = 0L
			var digits = 0
			while (i < len && s[i] in '0'..'9') {
				mant = mant * 10 + (s[i] - '0')
				digits++
				i++
			}
			var frac = 0
			if (i < len && s[i] == '.') {
				i++
				while (i < len && s[i] in '0'..'9') {
					mant = mant * 10 + (s[i] - '0')
					digits++
					frac++
					i++
				}
			}
			if (digits == 0) no()
			// an exponent, or more digits than a long keeps exactly: the general conversion
			if (i < len && (s[i] == 'e' || s[i] == 'E') || digits > 15 || frac > 22) {
				while (i < len && (s[i] in '0'..'9' || s[i] == '+' || s[i] == '-' || s[i] == '.' || s[i] == 'e' || s[i] == 'E')) i++
				return (String(s, start, i - start).toDoubleOrNull() ?: no()).toFloat()
			}
			// mant and 10^frac are exact doubles, so the quotient is the nearest double to the decimal: the same one parseDouble finds
			val v = if (frac == 0) mant.toDouble() else mant.toDouble() / POW10[frac]
			return (if (neg) -v else v).toFloat()
		}

		private fun points(): FloatArray {
			take('[')
			var buf = FloatArray(192)
			var n = 0
			if (peek() == ']') {
				i++
			} else {
				while (true) {
					if (n == buf.size) buf = buf.copyOf(n * 2)
					val v = number()
					if (!v.isFinite()) no()
					buf[n++] = v
					skip()
					if (i < len && s[i] == ',') {
						i++
						continue
					}
					take(']')
					break
				}
			}
			if (n % 3 != 0) no()
			return if (n == buf.size) buf else buf.copyOf(n)
		}

		private fun stroke(): InkWire.Stroke {
			take('{')
			var size = Float.NaN
			var color: String? = null
			var points: FloatArray? = null
			var fresh = true
			var first = true
			while (true) {
				if (peek() == '}') {
					i++
					break
				}
				if (!first) take(',')
				first = false
				val key = string()
				take(':')
				when (key) {
					"size" -> {
						if (!size.isNaN()) no()
						size = number()
					}
					"color" -> {
						if (color != null) no()
						color = string()
					}
					"points" -> {
						if (points != null) no()
						points = points()
					}
					"fresh" -> {
						skip()
						when {
							word("true") -> { fresh = true; i += 4 }
							word("false") -> { fresh = false; i += 5 }
							else -> no()
						}
					}
					else -> no()
				}
			}
			val p = points ?: no()
			if (!size.isFinite() || size <= 0f) no()
			// the same colour rule as the general reader: a #rrggbb or none
			val c = color?.takeIf { hexColor.matches(it) }
			return InkWire.Stroke(size, c, p, sent = !fresh)
		}

		fun strokes(): List<InkWire.Stroke> {
			take('[')
			val out = ArrayList<InkWire.Stroke>()
			if (peek() == ']') {
				i++
			} else {
				while (true) {
					out += stroke()
					skip()
					if (i < len && s[i] == ',') {
						i++
						continue
					}
					take(']')
					break
				}
			}
			skip()
			if (i != len) no()
			return out
		}
	}
}
