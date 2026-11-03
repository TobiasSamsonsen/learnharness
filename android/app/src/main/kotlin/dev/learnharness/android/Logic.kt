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
	/** The pairing token is 48 lowercase hex characters (24 random bytes); the server wants at least 32. */
	fun fromBytes(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

	/** A stored token is only used if it is a bare hex string the server will accept. */
	fun parse(text: String?): String? =
		text?.lineSequence()?.map { it.trim() }?.lastOrNull { it.isNotEmpty() }
			?.takeIf { Regex("[0-9a-f]{32,}").matches(it) }
}

/** What the activity should do next, from what it can see. */
sealed interface Next {
	/** Load the page (pairing is checked on the way). */
	data object Load : Next
	/** The guest or the server bundle is not installed yet: download and unpack it (no question asked: nothing works without it). */
	data object Provision : Next
	/** Claude is not signed in inside the guest. */
	data object Login : Next
	/** Everything is installed and signed in, but nothing answers: start the server. */
	data object Start : Next
}

object Flow {
	fun decide(dev: Boolean, healthy: Boolean, installed: Boolean, loggedIn: Boolean): Next = when {
		dev || healthy -> Next.Load
		!installed -> Next.Provision
		!loggedIn -> Next.Login
		else -> Next.Start
	}
}

object ServerEnv {
	/** What `lh start` exported to the server (android/termux/lh), plus the demo bridge's address when the shell has one (no Chromium inside the guest). */
	fun of(port: Int, token: String, bridgePort: Int = 0, bridgeToken: String = ""): Map<String, String> = mapOf(
		"NODE_ENV" to "production",
		"HOSTNAME" to "127.0.0.1",
		"PORT" to port.toString(),
		"LH_DATA_DIR" to "/root/lh-data",
		"LH_AUTH_FILE" to "/root/.lh/auth.json",
		"LH_UPSTREAM_CHECK" to "0",
		"LH_CLAUDE_CODE_MAX_SESSIONS" to "2",
		"LH_CLAUDE_IDLE_REUSE" to "1",
		"LH_ACCESS_TOKEN" to token,
	) + if (bridgePort > 0) mapOf("LH_DEMO_BRIDGE_URL" to "http://127.0.0.1:$bridgePort", "LH_DEMO_BRIDGE_TOKEN" to bridgeToken) else emptyMap()
}

/** The guest's /etc/resolv.conf: Android has none, so the shell writes the phone's own resolvers into it. */
object ResolvConf {
	private val FALLBACK = listOf("1.1.1.1", "8.8.8.8")

	/** `servers` as the network reports them (an IPv6 link-local one carries a `%wlan0` scope the guest cannot use); public resolvers only when there are none. */
	fun render(servers: List<String>): String {
		val usable = servers.map { it.substringBefore('%') }.filter { Regex("[0-9a-fA-F:.]+").matches(it) }.distinct()
		return (usable.ifEmpty { FALLBACK }).joinToString("") { "nameserver $it\n" }
	}
}

object FirstRun {
	/**
	 * The settings.json of a fresh install (owner decision, M12: the standalone app is ready to teach right after the Claude
	 * login; desktop and browser keep the no-defaults rule). strong = prober and teacher, cheap = the background agents,
	 * vision = figures and PDFs. All three are Claude Code models (upstream 0.4.0 names them by the CLI's aliases: opus,
	 * sonnet, haiku), which a subscription login serves. `claudeCode.enabled` is upstream's explicit opt-in: this file is
	 * only written after the sign-in has succeeded (the start flow does not get here otherwise), so the sign-in is the opt-in
	 * (owner decision, 2026-10-29).
	 */
	const val MODELS_SETTINGS = """{"claudeCode":{"enabled":true},"models":{"strong":{"model":{"provider":"claude-code","id":"opus"}},"cheap":{"model":{"provider":"claude-code","id":"haiku"}},"vision":{"model":{"provider":"claude-code","id":"sonnet"}}}}"""
}

/** The two release downloads the app unpacks into the guest (docs/android/m12-plan.md, step 1). */
object Release {
	/** The server bundle is republished with every build; the rootfs (Ubuntu, Node, claude) has its own, slower release. */
	const val DEFAULT_SERVER_BASE = "https://github.com/TobiasSamsonsen/learnharness/releases/download/android-latest"
	const val DEFAULT_ROOTFS_BASE = "https://github.com/TobiasSamsonsen/learnharness/releases/download/android-rootfs"
	const val ROOTFS = "learnharness-rootfs-linux-arm64.tar.gz"
	const val SERVER = "learnharness-server-linux-arm64.tar.zst"
	/**
	 * The claude CLI version this app release was tested with (owner decision, M12: pinned per app release, installed from npm
	 * on the phone at first run and whenever this changes; the rootfs release does not carry it).
	 */
	const val CLAUDE_VERSION = "2.1.312"
	const val ROOTFS_VERSION = "rootfs-version.txt"
	const val SERVER_VERSION = "version.txt"

	fun url(base: String, asset: String): String = base.trimEnd('/') + "/" + asset

	/** `<sha256>  <file name>` (sha256sum's output): the first token, if it is a sha256. */
	fun parseSha256(text: String?): String? =
		text?.trim()?.split(Regex("""\s+"""))?.firstOrNull()?.lowercase()?.takeIf { Regex("[0-9a-f]{64}").matches(it) }

	/** A version file holds one line; anything else counts as unknown. */
	fun parseVersion(text: String?): String? =
		text?.lineSequence()?.map { it.trim() }?.firstOrNull { it.isNotEmpty() }?.takeIf { it.length <= 80 }

	/** Out of date when the remote version is known and differs; an unreachable release never forces an update. */
	fun outdated(installed: String?, remote: String?): Boolean = remote != null && installed != remote

	/** The app's own APK: attached to the server release by android-apk.yml, next to its `.sha256`. */
	const val APK = "learnharness-android-debug.apk"

	/** BuildConfig.BUILD_STAMP of a local build: not a published build, so it is never offered an app update. */
	const val DEV_STAMP = "dev"

	/**
	 * An app update: the release's stamp (version.txt, written by the server workflow; the APK workflow stamps the APK with the
	 * same `<version>+<sha7>`) differs from the stamp this build was made with. Unknown (offline) never forces one.
	 */
	fun apkOutdated(builtStamp: String, remote: String?): Boolean = builtStamp != DEV_STAMP && outdated(builtStamp, remote)
}

/** What the shell does when it starts after an app update (the update is one tap: the rest carries on by itself). */
enum class Resume { NONE, CARRY_ON, DROP }

object UpdateResume {
	/**
	 * `expected` is the stamp written to `update.pending` before the install started. It matching the running build means the
	 * install happened: carry on with the server, the Linux environment and claude. A different one means it did not (declined,
	 * failed, or another build landed meanwhile): forget it; the normal check offers the update again.
	 */
	fun decide(expected: String?, builtStamp: String): Resume = when {
		expected == null -> Resume.NONE
		expected == builtStamp -> Resume.CARRY_ON
		else -> Resume.DROP
	}
}

/** The system installer's answer for the app update, as a line for the screen (PackageInstaller.STATUS_* by their values). */
object InstallStatus {
	fun message(status: Int, system: String?): String {
		val detail = system?.trim()?.takeIf { it.isNotEmpty() }?.let { " ($it)" } ?: ""
		return when (status) {
			2 -> "Android blocked the update$detail. Allow LearnHarness to install apps in Settings, then try again." // FAILURE_BLOCKED
			3 -> "The update was cancelled." // FAILURE_ABORTED: the confirmation was declined
			4 -> "Android refused the downloaded app as invalid$detail." // FAILURE_INVALID
			5 -> "Android could not replace the app because another install is running$detail. Try again in a moment." // FAILURE_CONFLICT
			6 -> "There is not enough storage on the device to install the update$detail." // FAILURE_STORAGE
			7 -> "Android refused the update: it is signed with a different key$detail." // FAILURE_INCOMPATIBLE
			else -> "The app update did not install$detail."
		}
	}
}

/** What `claude auth login` prints on its pty. */
object LoginOutput {
	private val ansi = Regex("""\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)""")

	fun clean(text: String): String = ansi.replace(text, "").replace("\r", "")

	/** The OAuth link; the terminal also wraps it in an OSC 8 hyperlink, which clean() has already removed. */
	fun url(text: String): String? =
		Regex("""https://claude\.(?:com|ai)/\S*oauth/authorize\S*""").find(clean(text))?.value

	fun succeeded(text: String): Boolean = clean(text).contains("Login successful")

	/** `claude auth status` prints JSON with `"loggedIn": true` when a subscription login is stored. */
	fun loggedIn(statusJson: String): Boolean = Regex(""""loggedIn"\s*:\s*true""").containsMatchIn(statusJson)
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
	/** A pairing link or token in any output must never reach the screen (or a log). */
	fun tokens(text: String): String =
		text.replace(Regex("lh_token=[0-9a-fA-F]+"), "lh_token=…").replace(Regex("[0-9a-f]{32,}"), "…")
}

/**
 * The camera, reached through the page's own file input (M17, docs/android/m17-plan.md): `<input type=file accept="image/ (any image)"
 * capture="environment">` makes WebView ask the shell's file chooser with `isCaptureEnabled`; the shell then opens the phone's
 * camera app itself and hands the photo back. Pure, so `./gradlew test` covers it.
 */
object PhotoCapture {
	/** Does this chooser request mean "take a photo"? An image input that asked for capture (a pdf-or-image picker never does). */
	fun wantsCamera(captureEnabled: Boolean, acceptTypes: Array<String>?): Boolean {
		if (!captureEnabled) return false
		val types = acceptTypes?.map { it.trim().lowercase() }?.filter { it.isNotEmpty() } ?: return false
		return types.isNotEmpty() && types.all { it.startsWith("image/") || it in IMAGE_EXTENSIONS }
	}

	/** The name of a new photo file (a timestamp, so two photos never collide). */
	fun fileName(nowMs: Long): String = "photo_$nowMs.jpg"

	/** Photos older than this are deleted the next time the camera opens (the page has long since uploaded them). */
	const val KEEP_MS = 24L * 60 * 60 * 1000

	/** Is this cached photo old enough to delete? */
	fun expired(lastModifiedMs: Long, nowMs: Long): Boolean = nowMs - lastModifiedMs > KEEP_MS

	private val IMAGE_EXTENSIONS = setOf(".jpg", ".jpeg", ".png", ".webp", ".gif")
}

/**
 * When an unused server may rest (owner decision, 2026-11-03: 10 and 45 minutes). "Unused" means the app is not on screen AND the
 * server reports no work in progress (a turn, a job, a sync round ...), so a long problem or a long model turn is never cut: the
 * clock only runs while nothing is happening. The first step drops the wake lock (the CPU may sleep, the server stays loaded, coming
 * back is instant); the second stops the server and its notification (the app starts it again on the next open).
 */
object IdlePolicy {
	const val RELEASE_WAKE_LOCK_MS = 10 * 60_000L
	const val STOP_SERVER_MS = 45 * 60_000L

	/** How often the service looks. Finer than a minute buys nothing: both limits are minutes long. */
	const val POLL_MS = 30_000L

	enum class Step { KEEP, RELEASE_WAKE_LOCK, STOP }

	/** The three durations. The real ones unless a device check shortened them (limitsFrom). */
	data class Limits(val releaseMs: Long, val stopMs: Long, val pollMs: Long) {
		companion object {
			val DEFAULT = Limits(RELEASE_WAKE_LOCK_MS, STOP_SERVER_MS, POLL_MS)
		}
	}

	/** What to do after `idleMs` of nothing in use. */
	fun step(idleMs: Long, limits: Limits = Limits.DEFAULT): Step = when {
		idleMs >= limits.stopMs -> Step.STOP
		idleMs >= limits.releaseMs -> Step.RELEASE_WAKE_LOCK
		else -> Step.KEEP
	}

	/** Should the wake lock be held after `idleMs` of nothing in use? (It is re-taken the moment something is in use again.) */
	fun holdWakeLock(idleMs: Long, limits: Limits = Limits.DEFAULT): Boolean = idleMs < limits.releaseMs

	/**
	 * Test seam: the optional file `idle-limits` in the app's private storage holds "release stop poll" in SECONDS, so a device check
	 * does not have to wait 45 minutes. Absent, malformed, or not release < stop with a poll of at least a second: the real limits.
	 */
	fun limitsFrom(text: String?): Limits {
		val n = text?.trim()?.split(Regex("\\s+"))?.map { it.toLongOrNull() ?: return Limits.DEFAULT } ?: return Limits.DEFAULT
		if (n.size != 3 || n.any { it < 1 } || n[0] >= n[1]) return Limits.DEFAULT
		return Limits(n[0] * 1000, n[1] * 1000, n[2] * 1000)
	}
}

/** The server's answer to GET /api/busy: `{"busy":false,"reasons":[]}`. */
object ServerBusy {
	fun url(port: Int): String = "http://127.0.0.1:$port/api/busy"

	/**
	 * true or false as the server said; null when the body is not a busy report (a starting server, an error page). Callers treat
	 * null as "in use": an answer nobody understood must never start the idle clock.
	 */
	fun parse(body: String): Boolean? {
		val m = Regex("\"busy\"\\s*:\\s*(true|false)").find(body) ?: return null
		return m.groupValues[1] == "true"
	}

	/** The Cookie header the server's token gate wants. */
	fun cookieHeader(token: String): String = "${Server.COOKIE}=$token"
}

/**
 * The guest's process tree. proot ignores SIGTERM, and when it is killed its tracees are NOT: on a Pixel 7 Pro the Node server
 * kept serving, orphaned, after the app had "stopped" it (2026-11-03). So stopping the server means signalling the whole tree
 * under proot, not proot alone. These are the pure parts (parsing /proc, walking the tree); ServerService does the signalling.
 */
object ProcessTree {
	/**
	 * The parent pid from a /proc/<pid>/stat line: "23599 (next-server (v) S 1 1077 ...". The command name sits in parentheses
	 * and may itself hold spaces and parentheses, so the fields are read after the LAST ")". null for anything else.
	 */
	fun parentOf(stat: String): Int? {
		val close = stat.lastIndexOf(')')
		if (close < 0) return null
		val rest = stat.substring(close + 1).trim().split(' ')
		return rest.getOrNull(1)?.toIntOrNull()
	}

	/** Every process below `root` (children first, then theirs), given pid -> parent pid for the processes that can be seen. Never includes `root`. */
	fun descendants(root: Int, parentOf: Map<Int, Int>): List<Int> {
		val byParent = parentOf.entries.groupBy({ it.value }, { it.key })
		val out = ArrayList<Int>()
		val seen = HashSet<Int>().apply { add(root) }
		val queue = ArrayDeque<Int>().apply { add(root) }
		while (queue.isNotEmpty()) {
			for (child in byParent[queue.removeFirst()].orEmpty()) {
				if (seen.add(child)) {
					out.add(child)
					queue.addLast(child)
				}
			}
		}
		return out
	}
}
