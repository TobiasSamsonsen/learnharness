package dev.learnharness.android

/**
 * The update lines on `window.lhAndroid` (docs/android/m15-plan.md): the fork's update card in the page asks whether a newer
 * release is installable (`update probe`), the shell answers `update available` once its background check has found one, and the
 * card's buttons send `update start` (download, unpack, restart) or `update later` (hidden until the next cold start).
 */
sealed interface UpdateOp {
	data object Probe : UpdateOp
	data object Start : UpdateOp
	data object Later : UpdateOp
}

object UpdateWire {
	const val AVAILABLE = "update available"

	fun isUpdate(line: String): Boolean = line.trimStart().startsWith("update ")

	/** The op a page line asks for, or null for anything else (an unknown verb is ignored, like [InkWire]). */
	fun parse(line: String): UpdateOp? = when (line.trim()) {
		"update probe" -> UpdateOp.Probe
		"update start" -> UpdateOp.Start
		"update later" -> UpdateOp.Later
		else -> null
	}
}
