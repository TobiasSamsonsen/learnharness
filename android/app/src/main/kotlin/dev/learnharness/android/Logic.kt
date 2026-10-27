package dev.learnharness.android

import kotlin.math.roundToInt

/** Everything here is pure, so `./gradlew test` covers it on the PC. */

object Server {
	const val DEFAULT_PORT = 3000
	const val COOKIE = "lh_token"

	/** The shell always loads 127.0.0.1: the server's Host gate allows it, `getUserMedia` needs a secure context, and the cookie jar is per host name. */
	fun base(port: Int): String = "http://127.0.0.1:$port/"

	fun healthUrl(port: Int): String = "http://127.0.0.1:$port/api/health"

	fun isInternal(url: String, port: Int): Boolean =
		url == base(port).trimEnd('/') || url.startsWith(base(port))

	/** `{"ok":true,"version":…,"tokenMode":…}`; a body that does not say `"ok":true` is not our server. */
	fun isHealthy(body: String): Boolean = Regex("\"ok\"\\s*:\\s*true").containsMatchIn(body)

	/** The Set-Cookie the server sends on pairing (HttpOnly, SameSite=Strict, 400 days), written through CookieManager. */
	fun cookie(token: String): String = "$COOKIE=$token; Path=/; Max-Age=34560000; HttpOnly; SameSite=Strict"
}

object Token {
	/**
	 * `lh pair --print-token` prints the token alone: 48 hex characters (the server wants at least 32).
	 * An older `lh` prints the pairing link instead and exits 0, so only a bare hex line counts.
	 */
	fun parse(stdout: String?): String? =
		stdout?.lineSequence()?.map { it.trim() }?.lastOrNull { it.isNotEmpty() }
			?.takeIf { Regex("[0-9a-f]{32,}").matches(it) }
}

/** What the activity should do next, from what it can see. */
sealed interface Next {
	/** Load the page (pairing is checked on the way). */
	data object Load : Next
	data object NeedTermux : Next
	data object NeedRunCommandPermission : Next
	/** The server is down and Termux is ready: run `lh start`. */
	data object Start : Next
}

object Flow {
	fun decide(dev: Boolean, healthy: Boolean, termuxInstalled: Boolean, runCommandGranted: Boolean): Next = when {
		dev || healthy -> Next.Load
		!termuxInstalled -> Next.NeedTermux
		!runCommandGranted -> Next.NeedRunCommandPermission
		else -> Next.Start
	}
}

/** What went wrong with a Termux call, from its result, so the status screen can name the one fix. */
enum class TermuxProblem { NONE, ALLOW_EXTERNAL_APPS, LH_MISSING, OTHER }

object TermuxResult {
	fun problem(exitCode: Int?, err: Int?, errmsg: String?, stderr: String?): TermuxProblem {
		val text = listOfNotNull(errmsg, stderr).joinToString("\n")
		return when {
			text.contains("allow-external-apps") -> TermuxProblem.ALLOW_EXTERNAL_APPS
			text.contains("No such file") || text.contains("not found") || exitCode == 127 -> TermuxProblem.LH_MISSING
			(err != null && err != -1) || (exitCode != null && exitCode != 0) -> TermuxProblem.OTHER
			else -> TermuxProblem.NONE
		}
	}
}

enum class BackAction { NONE, GO_BACK, EXIT }

object Back {
	/** The web asks its layers first (`lh:back`); then page history; then the app closes. */
	fun action(webHandled: Boolean, canGoBack: Boolean): BackAction = when {
		webHandled -> BackAction.NONE
		canGoBack -> BackAction.GO_BACK
		else -> BackAction.EXIT
	}

	/** Dispatch `lh:back` and read whether a layer closed (components/back-layers.ts). */
	const val SCRIPT =
		"(function(){var d={handled:false};window.dispatchEvent(new CustomEvent('lh:back',{detail:d}));return d.handled;})()"
}

object Insets {
	/** Real system-bar and cutout insets, in CSS px, written over M5's `env()`-based variables. */
	fun script(topPx: Int, rightPx: Int, bottomPx: Int, leftPx: Int, density: Float): String {
		fun css(px: Int) = (px / density).roundToInt()
		val style = "document.documentElement.style"
		return "$style.setProperty('--lh-safe-top','${css(topPx)}px');" +
			"$style.setProperty('--lh-safe-right','${css(rightPx)}px');" +
			"$style.setProperty('--lh-safe-bottom','${css(bottomPx)}px');" +
			"$style.setProperty('--lh-safe-left','${css(leftPx)}px');"
	}
}

object Redact {
	/** A pairing link or token in Termux output must never reach the screen (or a log). */
	fun tokens(text: String): String =
		text.replace(Regex("lh_token=[0-9a-fA-F]+"), "lh_token=…").replace(Regex("[0-9a-f]{32,}"), "…")
}
