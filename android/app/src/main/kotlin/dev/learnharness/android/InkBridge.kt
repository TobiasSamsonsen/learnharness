package dev.learnharness.android

import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * `window.lhAndroid` in the page (Android plan M10): `lhAndroid.postMessage(line)` carries the lines of [InkWire] (and, from M12,
 * the `speech` lines of [SpeechWire]) to the shell; the shell answers through `lhAndroid.onmessage` (the reply proxy). A WebMessageListener restricted to the
 * server's own origin and the main frame, exactly like `lhShell`: a sandboxed demo iframe (opaque origin) cannot reach it.
 */
class InkBridge(private val webView: WebView, private val frame: InkFrame, private val speech: SpeechBridge? = null) {
	private var reply: JavaScriptReplyProxy? = null

	fun install(origin: String) {
		if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
		WebViewCompat.removeWebMessageListener(webView, NAME)
		WebViewCompat.addWebMessageListener(webView, NAME, setOf(origin)) { _, message: WebMessageCompat, _, isMainFrame, proxy ->
			if (!isMainFrame) return@addWebMessageListener
			reply = proxy
			frame.send = { line -> reply?.postMessage(line) }
			val data = message.data.orEmpty()
			// the dictation lines of M12 step 6 share this channel; they are not ink
			if (SpeechWire.isSpeech(data)) {
				speech?.handle(data) { line -> reply?.postMessage(line) }
				return@addWebMessageListener
			}
			val op = InkWire.parse(data) ?: return@addWebMessageListener
			frame.apply(op)
		}
	}

	fun remove() {
		speech?.close()
		if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) WebViewCompat.removeWebMessageListener(webView, NAME)
		frame.apply(InkOp.Close)
	}

	private companion object {
		const val NAME = "lhAndroid"
	}
}
