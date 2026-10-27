package dev.learnharness.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * The shell: one WebView on the Termux server, plus a status screen while the server is down or
 * Termux is not ready. All decisions that can be tested without a device live in Logic.kt.
 */
class MainActivity : ComponentActivity() {
	private val prefs by lazy { getSharedPreferences("lh", MODE_PRIVATE) }
	private var port: Int
		get() = prefs.getInt("port", Server.DEFAULT_PORT)
		set(value) = prefs.edit().putInt("port", value).apply()
	private var dev: Boolean
		get() = BuildConfig.DEBUG && prefs.getBoolean("dev", false)
		set(value) = prefs.edit().putBoolean("dev", value).apply()

	private lateinit var webView: WebView
	private lateinit var inkFrame: InkFrame
	private lateinit var inkBridge: InkBridge
	private lateinit var status: LinearLayout
	private lateinit var title: TextView
	private lateinit var detail: TextView
	private lateinit var primary: Button
	private lateinit var secondary: Button
	private lateinit var portField: EditText
	private lateinit var devSwitch: Switch
	private lateinit var root: FrameLayout

	/** A page is up (or loading); the status screen is hidden. */
	private var pageShown = false
	/** A connect attempt is running; a second one waits for it. */
	private var busy = false
	private var attempt = 0
	/** After a 403 "Not paired" we re-read the token once; this stops a loop when that does not help. */
	private var rePaired = false
	private var saw403 = false
	private var insetsScript = ""

	private var pendingMic: PermissionRequest? = null
	private var fileCallback: ValueCallback<Array<Uri>>? = null
	private var pendingSave: ByteArray? = null

	private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
		pendingMic?.let { if (granted) it.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else it.deny() }
		pendingMic = null
	}
	private val termuxPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
		// the "Additional permissions" of an app are often not promptable: send the user to the settings page
		if (!granted && !Termux.permissionGranted(this)) openAppSettings() else begin()
	}
	private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
		fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
		fileCallback = null
	}
	private val saveDocument = registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
		val bytes = pendingSave
		pendingSave = null
		if (uri != null && bytes != null) {
			try {
				contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
			} catch (_: Exception) {
				// the document picker owns the failure UI; nothing to add here
			}
		}
	}

	override fun onCreate(savedInstanceState: Bundle?) {
		enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))
		super.onCreate(savedInstanceState)
		applyIntent(intent)
		buildViews()
		onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
			override fun handleOnBackPressed() = onBack()
		})
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		// a plain launcher tap on the running app must not reload the page (and lose a sketch or a dictation)
		if (applyIntent(intent) || !pageShown) begin()
	}

	override fun onResume() {
		super.onResume()
		if (!pageShown && !busy) begin()
	}

	/** `adb shell am start -n dev.learnharness.android/.MainActivity --ez lh.dev true|false` flips dev mode (debug builds). */
	private fun applyIntent(intent: Intent?): Boolean {
		if (!BuildConfig.DEBUG || intent?.hasExtra("lh.dev") != true) return false
		val on = intent.getBooleanExtra("lh.dev", false)
		val changed = on != dev
		dev = on
		return changed
	}

	// ── views ────────────────────────────────────────────────────────────────

	private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

	@SuppressLint("SetJavaScriptEnabled")
	private fun buildViews() {
		root = FrameLayout(this).apply { setBackgroundColor(BACKGROUND) }
		webView = WebView(this).apply {
			setBackgroundColor(BACKGROUND)
			visibility = View.GONE
			settings.apply {
				javaScriptEnabled = true
				domStorageEnabled = true
				mediaPlaybackRequiresUserGesture = false
				allowFileAccess = false
				allowContentAccess = false
				cacheMode = WebSettings.LOAD_DEFAULT
			}
		}
		CookieManager.getInstance().apply {
			setAcceptCookie(true)
			setAcceptThirdPartyCookies(webView, false)
		}
		WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
		inkFrame = InkFrame(this, webView, BACKGROUND)
		inkBridge = InkBridge(webView, inkFrame)
		installBridge()
		webView.webViewClient = client
		webView.webChromeClient = chrome

		title = TextView(this).apply { setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f); gravity = Gravity.CENTER }
		detail = TextView(this).apply { setTextColor(0xFFB0B0B0.toInt()); setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f); gravity = Gravity.CENTER; setPadding(0, dp(12), 0, dp(20)) }
		primary = Button(this)
		secondary = Button(this)
		portField = EditText(this).apply {
			inputType = InputType.TYPE_CLASS_NUMBER
			setTextColor(Color.WHITE)
			setHintTextColor(0xFF808080.toInt())
			hint = "Server port"
			setText(port.toString())
			gravity = Gravity.CENTER
		}
		devSwitch = Switch(this).apply {
			text = "Dev server (PC, adb reverse)"
			setTextColor(0xFFB0B0B0.toInt())
			isChecked = dev
			visibility = if (BuildConfig.DEBUG) View.VISIBLE else View.GONE
			setOnCheckedChangeListener { _, on -> dev = on; begin() }
		}
		status = LinearLayout(this).apply {
			orientation = LinearLayout.VERTICAL
			gravity = Gravity.CENTER
			setPadding(dp(24), dp(24), dp(24), dp(24))
			visibility = View.GONE
			val wide = LinearLayout.LayoutParams(dp(320), ViewGroup.LayoutParams.WRAP_CONTENT)
			addView(title, wide)
			addView(detail, wide)
			addView(primary, wide)
			addView(secondary, wide)
			addView(portField, wide)
			addView(devSwitch, wide)
		}
		root.addView(inkFrame, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
		root.addView(status, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
		setContentView(root)

		ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
			val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
			val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
			// with the keyboard up the page shrinks above it, so the gesture bar no longer overlaps it
			val bottom = if (keyboard > 0) 0 else bars.bottom
			root.setPadding(0, 0, 0, if (keyboard > 0) keyboard else 0)
			status.setPadding(bars.left + dp(24), bars.top + dp(24), bars.right + dp(24), bottom + dp(24))
			insetsScript = Insets.script(bars.top, bars.right, bottom, bars.left, resources.displayMetrics.density)
			if (pageShown) webView.evaluateJavascript(insetsScript, null)
			insets
		}
	}

	private fun show(titleText: String, detailText: String, primaryLabel: String?, onPrimary: () -> Unit, secondaryLabel: String? = null, onSecondary: () -> Unit = {}, controls: Boolean = true) {
		pageShown = false
		webView.visibility = View.GONE
		status.visibility = View.VISIBLE
		title.text = titleText
		detail.text = detailText
		primary.visibility = if (primaryLabel == null) View.GONE else View.VISIBLE
		primary.text = primaryLabel
		primary.setOnClickListener { onPrimary() }
		secondary.visibility = if (secondaryLabel == null) View.GONE else View.VISIBLE
		secondary.text = secondaryLabel
		secondary.setOnClickListener { onSecondary() }
		portField.visibility = if (controls) View.VISIBLE else View.GONE
		devSwitch.visibility = if (controls && BuildConfig.DEBUG) View.VISIBLE else View.GONE
		portField.setText(port.toString())
		devSwitch.setOnCheckedChangeListener(null)
		devSwitch.isChecked = dev
		devSwitch.setOnCheckedChangeListener { _, on -> dev = on; begin() }
	}

	private fun showWorking(text: String) = show(text, "", null, {}, controls = false)

	/** Reads the port field (the status screen's only setting) before a retry. */
	private fun retry() {
		portField.text.toString().toIntOrNull()?.takeIf { it in 1..65535 }?.let {
			if (it != port) {
				port = it
				installBridge()
			}
		}
		begin()
	}

	private fun openAppSettings() {
		startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
	}

	private fun openTermux() {
		packageManager.getLaunchIntentForPackage(Termux.PACKAGE)?.let { startActivity(it) }
	}

	// ── flow ─────────────────────────────────────────────────────────────────

	/** Look at the server and Termux, then do the one next thing (Logic.kt: Flow.decide). */
	private fun begin(afterStart: Boolean = false) {
		if (busy) return
		busy = true
		val my = ++attempt
		showWorking(if (dev) "Connecting to the dev server…" else "Connecting…")
		val p = port
		thread {
			val healthy = !dev && checkHealth(p)
			runOnUiThread {
				if (my != attempt) return@runOnUiThread
				busy = false
				when (Flow.decide(dev, healthy, Termux.installed(this), Termux.permissionGranted(this))) {
					Next.Load -> load()
					Next.NeedTermux -> show(
						"Termux is not installed",
						"The server runs in Termux. Install Termux from F-Droid or GitHub (the Play Store build is outdated), then run `lh install` there.",
						"Check again", ::retry,
					)
					Next.NeedRunCommandPermission -> show(
						"Allow starting the server",
						"learnharness needs the \"Run commands in Termux environment\" permission (App settings → Permissions → Additional permissions), and Termux needs `allow-external-apps=true` in ~/.termux/termux.properties.",
						"Grant permission", { termuxPermission.launch(Termux.PERMISSION) },
						"App settings", ::openAppSettings,
					)
					// `lh start` came back fine but nothing answers on our port: asking again would loop forever
					Next.Start -> if (afterStart) {
						show(
							"The server does not answer on port $p",
							"`lh start` finished, but nothing answers here. Set the same port as PORT in ~/.lh/config (default 3000).",
							"Try again", ::retry, "Open Termux", ::openTermux,
						)
					} else {
						startServer()
					}
				}
			}
		}
	}

	private fun checkHealth(p: Int): Boolean = try {
		val c = URL(Server.healthUrl(p)).openConnection() as HttpURLConnection
		c.connectTimeout = 1500
		c.readTimeout = 1500
		c.useCaches = false
		try {
			c.responseCode == 200 && Server.isHealthy(c.inputStream.bufferedReader().use { it.readText() })
		} finally {
			c.disconnect()
		}
	} catch (_: Exception) {
		false
	}

	private fun startServer() {
		busy = true
		showWorking("Starting the server…")
		detail.text = "Termux runs `lh start`; this takes up to a minute."
		Termux.run(this, listOf("start"), 130_000) { reply ->
			busy = false
			if (reply.problem == TermuxProblem.NONE) begin(afterStart = true) else showProblem(reply, "Could not start the server")
		}
	}

	private fun showProblem(reply: TermuxReply, headline: String) {
		val text = when (reply.problem) {
			TermuxProblem.ALLOW_EXTERNAL_APPS ->
				"Add `allow-external-apps=true` to ~/.termux/termux.properties in Termux, run `termux-reload-settings`, then try again."
			TermuxProblem.LH_MISSING ->
				"`lh` is not installed in Termux. Install it (see android/termux/README.md), run `lh install`, then try again."
			// stdout is left out on purpose: `lh start` and an old `lh pair` print the pairing link there
			else -> Redact.tokens(listOfNotNull(reply.errmsg, reply.stderr.takeLast(400)).filter { it.isNotBlank() }.joinToString("\n"))
				.ifBlank { "Termux gave no details." }
		}
		show(headline, text, "Try again", ::retry, "Open Termux", ::openTermux)
	}

	/** Pair when there is no cookie, then load. */
	private fun load() {
		if (dev || hasCookie()) {
			open()
			return
		}
		pair { open() }
	}

	private fun hasCookie(): Boolean =
		CookieManager.getInstance().getCookie(Server.base(port))?.contains("${Server.COOKIE}=") == true

	/** `lh pair --print-token` through Termux, then the cookie the server would have set. */
	private fun pair(then: () -> Unit) {
		busy = true
		showWorking("Pairing…")
		Termux.run(this, listOf("pair", "--print-token"), 20_000) { reply ->
			busy = false
			val token = Token.parse(reply.stdout)
			if (token != null) {
				CookieManager.getInstance().apply {
					setCookie(Server.base(port), Server.cookie(token))
					flush()
				}
				then()
			} else {
				val problem = reply.problem
				val shown = if (problem == TermuxProblem.NONE) {
					TermuxReply(reply.exitCode, reply.stdout, "Termux did not return a token. Update lh in Termux (`lh update`) and try again.", reply.err, reply.errmsg)
				} else {
					reply
				}
				showProblem(shown, "Could not pair")
			}
		}
	}

	private fun open() {
		pageShown = true
		saw403 = false
		status.visibility = View.GONE
		webView.visibility = View.VISIBLE
		webView.loadUrl(Server.base(port))
	}

	private fun onBack() {
		if (!pageShown) {
			finish()
			return
		}
		webView.evaluateJavascript(Back.SCRIPT) { result ->
			when (Back.action(webHandled = result == "true", canGoBack = webView.canGoBack())) {
				BackAction.NONE -> Unit
				BackAction.GO_BACK -> webView.goBack()
				BackAction.EXIT -> finish()
			}
		}
	}

	// ── WebView ──────────────────────────────────────────────────────────────

	private val client = object : WebViewClient() {
		override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
			val url = request.url.toString()
			if (Server.isInternal(url, port)) return false
			try {
				startActivity(Intent(Intent.ACTION_VIEW, request.url))
			} catch (_: ActivityNotFoundException) {
				// no app handles it: stay where we are
			}
			return true
		}

		override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
			inkFrame.apply(InkOp.Close) // a new page has not opened the native ink layer
		}

		override fun onPageFinished(view: WebView, url: String?) {
			if (url == null || !Server.isInternal(url, port)) return
			view.evaluateJavascript(insetsScript + DOWNLOAD_HOOK, null)
			if (!saw403) rePaired = false
		}

		override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
			if (!request.isForMainFrame || errorResponse.statusCode != 403 || dev) return
			saw403 = true
			// "Not paired": the token was rotated or the cookie is gone. Re-read it once.
			if (rePaired) {
				show("Pairing failed", "The server still refuses this app. Run `lh pair --rotate` in Termux, then try again.", "Try again", ::retry, "Open Termux", ::openTermux)
				return
			}
			rePaired = true
			CookieManager.getInstance().apply {
				removeAllCookies(null)
				flush()
			}
			if (!busy) pair { open() }
		}

		override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
			if (!request.isForMainFrame) return
			show("The server is not reachable", error.description.toString(), "Try again", ::retry, "Open Termux", ::openTermux)
		}
	}

	private val chrome = object : WebChromeClient() {
		override fun onPermissionRequest(request: PermissionRequest) {
			runOnUiThread {
				val ours = Server.isInternal(request.origin.toString(), port)
				if (!ours || PermissionRequest.RESOURCE_AUDIO_CAPTURE !in request.resources) {
					request.deny()
					return@runOnUiThread
				}
				if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
					request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
				} else {
					pendingMic?.deny()
					pendingMic = request
					micPermission.launch(Manifest.permission.RECORD_AUDIO)
				}
			}
		}

		override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
			fileCallback?.onReceiveValue(null)
			fileCallback = callback
			return try {
				fileChooser.launch(params.createIntent())
				true
			} catch (_: ActivityNotFoundException) {
				fileCallback = null
				callback.onReceiveValue(null)
				false
			}
		}
	}

	/**
	 * The page's save-a-file hook (see DOWNLOAD_HOOK) posts `name
base64` here; the system picker picks where the
	 * file goes. A WebMessageListener, not addJavascriptInterface: it exists only in frames of the server's own origin,
	 * so the sandboxed demo iframes (opaque origin) cannot reach it.
	 */
	private fun installBridge() {
		if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
		WebViewCompat.removeWebMessageListener(webView, "lhShell")
		WebViewCompat.addWebMessageListener(webView, "lhShell", setOf(Server.base(port).trimEnd('/'))) { _, message: WebMessageCompat, _, isMainFrame, _ ->
			if (isMainFrame) save(message.data.orEmpty())
		}
		inkBridge.install(Server.base(port).trimEnd('/')) // the native ink layer's `lhAndroid` (M10)
	}

	private fun save(message: String) {
		val split = message.indexOf('\n')
		if (split < 0) return
		val bytes = try {
			Base64.decode(message.substring(split + 1), Base64.DEFAULT)
		} catch (_: IllegalArgumentException) {
			return
		}
		pendingSave = bytes
		saveDocument.launch(message.substring(0, split).ifBlank { "download" })
	}

	override fun onDestroy() {
		WebViewCompat.removeWebMessageListener(webView, "lhShell")
		inkBridge.remove()
		super.onDestroy()
	}

	private companion object {
		const val BACKGROUND = 0xFF151210.toInt()

		/**
		 * The web app saves files with an `<a download>`: a detached blob link revoked right after the click
		 * (components/artifacts/download.ts, the conversation export), or a same-origin route whose filename the
		 * server sets (the sidebar's chat export). A WebView has no download manager here and would hand a revoked
		 * blob URL over too late, so the click is intercepted: the file is read at once and posted to the shell.
		 */
		const val DOWNLOAD_HOOK = """
			(function(){
				if (window.__lhDownloadHook) return; window.__lhDownloadHook = true;
				var orig = HTMLAnchorElement.prototype.click;
				HTMLAnchorElement.prototype.click = function(){
					var a = this, href = a.href;
					if (a.hasAttribute('download') && window.lhShell && (/^blob:/.test(href) || href.indexOf(location.origin + '/') === 0)) {
						var given = a.getAttribute('download');
						fetch(href, {credentials: 'same-origin'}).then(function(r){
							var m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(r.headers.get('content-disposition') || '');
							var name = given || (m ? decodeURIComponent(m[1]) : 'download');
							return r.blob().then(function(b){
								var f = new FileReader();
								f.onload = function(){ lhShell.postMessage(name + '\n' + String(f.result).split(',')[1]); };
								f.readAsDataURL(b);
							});
						});
						return;
					}
					return orig.call(this);
				};
			})();
		"""
	}
}
