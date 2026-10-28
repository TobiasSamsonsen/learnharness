package dev.learnharness.android

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/**
 * The demo browser (docs/android/m12-plan.md, step 5). The Linux guest has no Chromium, so the server asks the shell:
 * `POST /run-demo {html, probe, settleMs}` on a loopback port, guarded by a token the server gets in its environment
 * (LH_DEMO_BRIDGE_URL / LH_DEMO_BRIDGE_TOKEN; src/agent/subagents/headless-bridge.ts is the client). Each run loads the html
 * into a fresh system WebView, lets it settle, evaluates the optional probe (awaiting a promise) and answers with what
 * the page printed: console errors, uncaught exceptions, failed sub-requests, the probe's value. The demo is model-written
 * code: its WebView gets no bridge object, no cookies and no file access.
 */
class DemoBridge(private val context: Context, private val token: String) {
	private var socket: ServerSocket? = null
	private val main = Handler(Looper.getMainLooper())
	private val runs = Any()

	val port: Int get() = socket?.localPort ?: 0

	fun start() {
		val s = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
		socket = s
		Thread({
			while (!s.isClosed) {
				val client = try { s.accept() } catch (_: java.io.IOException) { break }
				Thread({ serve(client) }, "demo-bridge-request").start()
			}
		}, "demo-bridge").start()
	}

	fun stop() {
		socket?.close()
		socket = null
	}

	private fun serve(client: Socket) {
		try {
			client.use {
				client.soTimeout = 10_000
				val out = client.getOutputStream()
				val request = try { LoopbackHttp.read(client.getInputStream()) } catch (_: Exception) { null }
				val reply = when {
					request == null -> LoopbackHttp.response(400, """{"error":"bad request"}""")
					!LoopbackHttp.tokenMatches(request.headers["x-lh-token"], token) -> LoopbackHttp.response(403, """{"error":"forbidden"}""")
					request.method != "POST" || request.path != "/run-demo" -> LoopbackHttp.response(404, """{"error":"not found"}""")
					else -> try {
						val body = JSONObject(request.body)
						val probe = if (body.isNull("probe")) null else body.getString("probe")
						val result = synchronized(runs) { run(body.getString("html"), probe, body.optLong("settleMs", 2000)) }
						LoopbackHttp.response(200, result.toString())
					} catch (e: Exception) {
						LoopbackHttp.response(500, JSONObject().put("error", e.message ?: e.javaClass.simpleName).toString())
					}
				}
				out.write(reply)
				out.flush()
			}
		} catch (_: Exception) {
			// the caller hung up before the answer was written; nothing to report
		}
	}

	/** Runs one demo and blocks until it is done (or has timed out). */
	private fun run(html: String, probe: String?, settleMs: Long): JSONObject {
		val done = CompletableFuture<JSONObject>()
		main.post { Run(html, probe, settleMs.coerceIn(0, 15_000), done).begin() }
		return done.get(LOAD_TIMEOUT_MS + 15_000 + 15_000, TimeUnit.MILLISECONDS)
	}

	/** One page load. All of its state is touched on the main thread only. */
	@SuppressLint("SetJavaScriptEnabled")
	private inner class Run(private val html: String, private val probe: String?, private val settleMs: Long, private val done: CompletableFuture<JSONObject>) {
		private val consoleErrors = JSONArray()
		private val pageErrors = JSONArray()
		private val failedRequests = JSONArray()
		private var finished = false
		private val webView = WebView(context)

		fun begin() {
			webView.settings.apply {
				javaScriptEnabled = true
				domStorageEnabled = true
				allowFileAccess = false
				allowContentAccess = false
				mediaPlaybackRequiresUserGesture = false
			}
			CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
			host?.addView(webView, ViewGroup.LayoutParams(1, 1)) // a window is what makes requestAnimationFrame tick
			if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
				WebViewCompat.addDocumentStartJavaScript(webView, DemoPage.ERROR_HOOK, setOf("*"))
			}
			webView.webChromeClient = object : WebChromeClient() {
				override fun onConsoleMessage(message: ConsoleMessage): Boolean {
					if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) consoleErrors.put(message.message())
					return true
				}
			}
			webView.webViewClient = object : WebViewClient() {
				override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
					// the main frame is the data: page itself; only sub-requests (CDN scripts, images) count, as Chromium's requestfailed did
					if (!request.isForMainFrame) failedRequests.put("${request.url} (${error.description})")
				}

				override fun onPageFinished(view: WebView, url: String?) {
					if (finished) return
					main.postDelayed({ afterSettle() }, settleMs)
				}

				override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) = Unit
			}
			webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
			main.postDelayed({
				if (!finished) {
					pageErrors.put("navigation timeout of ${LOAD_TIMEOUT_MS} ms exceeded")
					afterSettle()
				}
			}, LOAD_TIMEOUT_MS)
		}

		private fun afterSettle() {
			if (finished) return
			// the load may have timed out above; this runs once either way
			finished = true
			if (probe == null) return collect(null, null)
			webView.evaluateJavascript(DemoPage.probeStart(probe), null)
			pollProbe(System.currentTimeMillis() + PROBE_TIMEOUT_MS)
		}

		private fun pollProbe(deadline: Long) {
			webView.evaluateJavascript(DemoPage.PROBE_READ) { raw ->
				val text = DemoPage.unquote(raw)
				when {
					text != null -> {
						val o = JSONObject(text)
						collect(if (o.has("v")) o.get("v") else null, o.optString("err").ifEmpty { null })
					}
					System.currentTimeMillis() > deadline -> collect(null, "timed out after ${PROBE_TIMEOUT_MS} ms")
					else -> main.postDelayed({ pollProbe(deadline) }, 100)
				}
			}
		}

		private fun collect(probeValue: Any?, probeError: String?) {
			if (probeError != null) pageErrors.put("probe failed: $probeError")
			webView.evaluateJavascript(DemoPage.ERRORS_READ) { raw ->
				DemoPage.unquote(raw)?.let { JSONArray(it) }?.let { hook -> for (i in 0 until hook.length()) pageErrors.put(hook.getString(i)) }
				val result = JSONObject()
					.put("consoleErrors", consoleErrors)
					.put("pageErrors", pageErrors)
					.put("failedRequests", failedRequests)
				if (probeValue != null && probeValue != JSONObject.NULL) result.put("probeResult", probeValue)
				(webView.parent as? ViewGroup)?.removeView(webView)
				webView.destroy()
				done.complete(result)
			}
		}
	}

	companion object {
		const val LOAD_TIMEOUT_MS = 30_000L
		const val PROBE_TIMEOUT_MS = 15_000L

		/** The visible activity's root, set while it is resumed: a WebView with a window gets animation frames. */
		@Volatile var host: ViewGroup? = null
	}
}

/** The JavaScript the shell injects; kept as constants so the wire contract is readable in one place. */
object DemoPage {
	/** Uncaught exceptions and rejections, collected where the WebView API has no pageerror event. */
	const val ERROR_HOOK = """
		window.__lhErrors = [];
		window.addEventListener('error', function(e){ window.__lhErrors.push(String(e.message || e.error || e)); });
		window.addEventListener('unhandledrejection', function(e){ window.__lhErrors.push('unhandled rejection: ' + String(e.reason)); });
	"""

	const val ERRORS_READ = "JSON.stringify(window.__lhErrors || [])"

	/** Starts the probe (an expression, possibly an async IIFE) and parks its settled value for [PROBE_READ] to find. */
	fun probeStart(probe: String): String =
		"window.__lhProbeDone = null; Promise.resolve().then(function(){ return (0, eval)(" + JSONObject.quote(probe) + "); })" +
			".then(function(v){ window.__lhProbeDone = JSON.stringify({v: v === undefined ? null : v}); })" +
			".catch(function(e){ window.__lhProbeDone = JSON.stringify({err: String(e && e.message || e)}); });"

	const val PROBE_READ = "window.__lhProbeDone"

	/** evaluateJavascript hands a JSON-encoded result back: a quoted string, or the text null when there is none. */
	fun unquote(raw: String?): String? {
		if (raw == null || raw == "null") return null
		return JSONArray("[$raw]").getString(0)
	}
}

/** Just enough HTTP for one JSON request on a loopback socket; pure, so the unit tests cover it. */
object LoopbackHttp {
	class Request(val method: String, val path: String, val headers: Map<String, String>, val body: String)

	private const val MAX_BODY = 8 * 1024 * 1024

	fun read(input: InputStream): Request {
		val head = ByteArrayOutputStream()
		var last4 = 0
		while (true) {
			val b = input.read()
			if (b < 0) throw java.io.IOException("closed before the headers ended")
			head.write(b)
			last4 = (last4 shl 8) or b
			if (last4 == 0x0D0A0D0A) break
			if (head.size() > 16 * 1024) throw java.io.IOException("headers too large")
		}
		val lines = head.toString("ISO-8859-1").split("\r\n").filter { it.isNotEmpty() }
		val (method, path) = lines.first().split(" ").let { it[0] to it.getOrElse(1) { "" } }
		val headers = lines.drop(1).mapNotNull { l -> l.indexOf(':').takeIf { it > 0 }?.let { l.substring(0, it).trim().lowercase() to l.substring(it + 1).trim() } }.toMap()
		val length = headers["content-length"]?.toIntOrNull() ?: 0
		if (length < 0 || length > MAX_BODY) throw java.io.IOException("body too large")
		val body = ByteArray(length)
		var read = 0
		while (read < length) {
			val n = input.read(body, read, length - read)
			if (n < 0) throw java.io.IOException("closed before the body ended")
			read += n
		}
		return Request(method, path, headers, String(body, Charsets.UTF_8))
	}

	fun response(status: Int, json: String): ByteArray {
		val reason = mapOf(200 to "OK", 400 to "Bad Request", 403 to "Forbidden", 404 to "Not Found", 500 to "Internal Server Error")[status] ?: "Status"
		val body = json.toByteArray(Charsets.UTF_8)
		val head = "HTTP/1.1 $status $reason\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n"
		return head.toByteArray(Charsets.ISO_8859_1) + body
	}

	/** Constant-time comparison; a missing header never matches. */
	fun tokenMatches(given: String?, expected: String): Boolean =
		given != null && MessageDigest.isEqual(given.toByteArray(), expected.toByteArray())
}
