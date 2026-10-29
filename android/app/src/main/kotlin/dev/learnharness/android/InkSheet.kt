package dev.learnharness.android

/**
 * The sheet's tone (Android plan M13): on a DARK sheet ink is SHOWN in a lighter variant while the strokes keep the
 * colours they were drawn in (the model's image stays white). The same table as components/sketch/sketch-sheet.ts.
 * Pure (no android.graphics), so `./gradlew test` covers it.
 */
object InkSheet {
	const val DEFAULT_INK = "#111111"

	/** The dark sheet's colour. */
	const val DARK_PAPER = 0xFF1C1917.toInt()
	const val LIGHT_PAPER = 0xFFFFFFFF.toInt()

	private val darkInk = mapOf(
		DEFAULT_INK to "#f5f5f4",
		"#dc2626" to "#f87171",
		"#16a34a" to "#4ade80",
		"#ea580c" to "#fb923c",
		"#2563eb" to "#60a5fa",
	)

	/** `#rrggbb` as an opaque ARGB int. */
	private fun argb(hex: String): Int = (0xFF000000.toInt()) or hex.substring(1).toInt(16)

	/** How a stroke's colour (`#rrggbb`, or null for the default ink) is shown on this sheet, as an ARGB int. */
	fun displayColor(hex: String?, dark: Boolean): Int {
		val c = (hex ?: DEFAULT_INK).lowercase()
		if (!dark) return argb(c)
		darkInk[c]?.let { return argb(it) }
		// a colour the table does not know: dark ones are blended toward white
		val n = c.substring(1).toInt(16)
		val r = (n shr 16) and 255
		val g = (n shr 8) and 255
		val b = n and 255
		val luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
		if (luminance >= 0.55) return argb(c)
		fun mix(v: Int) = Math.round(v + (255 - v) * 0.55).toInt()
		return (0xFF000000.toInt()) or (mix(r) shl 16) or (mix(g) shl 8) or mix(b)
	}
}
