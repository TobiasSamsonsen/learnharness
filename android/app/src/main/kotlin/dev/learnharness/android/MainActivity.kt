package dev.learnharness.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
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
import android.view.WindowManager
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
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * The shell: one WebView on the server that runs inside the app's own Linux guest (docs/android/m12-plan.md), plus a
 * status screen for first-run setup, the Claude sign-in and a server that is down. All decisions that can be tested
 * without a device live in Logic.kt.
 */
class MainActivity : ComponentActivity() {
	private val prefs by lazy { getSharedPreferences("lh", MODE_PRIVATE) }
	private val guest by lazy { Guest(this) }
	private val provisioner by lazy {
		val override = prefs.getString("release", null).takeIf { BuildConfig.DEBUG }
		Provisioner(guest, filesDir, override ?: Release.DEFAULT_ROOTFS_BASE, override ?: Release.DEFAULT_SERVER_BASE)
	}
	private val login by lazy { ClaudeLogin(guest) }
	private val tokens by lazy { TokenStore(File(filesDir, "token")) }
	private var loginUrl: String? = null
	/** The sign-in is running: coming back from the browser must not start it again. */
	private var loginActive = false
	private var askedNotifications = false
	/** "Not now" on the update card: not offered again until the next cold start. */
	private var skipUpdate = false
	/** The background check found a newer release; the page's card offers it (it probes, we answer). */
	private var updateReady = false
	/** The check runs once per cold start. */
	private var updateChecked = false
	private var updateReply: ((String) -> Unit)? = null
	/** The page of this load asked (`update probe`): it has the card. A server older than the card never does. */
	private var updateProbed = false
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
	private lateinit var codeField: EditText
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
	/** The server runs as a foreground service; without this permission its notification is hidden, but it still runs. */
	private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> begin() }
	/** The microphone for the system recognizer (SpeechBridge); the WebView's own getUserMedia request has its launcher above. */
	private var speechMicCallback: ((Boolean) -> Unit)? = null
	private val speechMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
		speechMicCallback?.invoke(granted)
		speechMicCallback = null
	}
	private val speech by lazy { SpeechBridge(this, ::askMicrophone) }
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
		if (applyIntent(intent) || (!pageShown && !loginActive)) begin()
	}

	override fun onPause() {
		DemoBridge.host = null
		super.onPause()
	}

	override fun onResume() {
		super.onResume()
		DemoBridge.host = root
		if (!pageShown && !busy && !loginActive) begin()
	}

	/**
	 * Debug builds only. `adb shell am start -n dev.learnharness.android/.MainActivity --ez lh.dev true|false` flips dev
	 * mode; `--es lh.release <base url>` points both first-run downloads at another host (a PC through `adb reverse`).
	 */
	private fun applyIntent(intent: Intent?): Boolean {
		if (!BuildConfig.DEBUG || intent == null) return false
		var changed = false
		if (intent.hasExtra("lh.dev")) {
			val on = intent.getBooleanExtra("lh.dev", false)
			changed = on != dev
			dev = on
		}
		intent.getStringExtra("lh.release")?.let {
			prefs.edit().putString("release", it.ifBlank { null }).apply()
			changed = true
		}
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
		inkBridge = InkBridge(webView, inkFrame, speech, ::onUpdateOp)
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
		codeField = EditText(this).apply {
			inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
			setTextColor(Color.WHITE)
			setHintTextColor(0xFF808080.toInt())
			hint = "Code from the sign-in page"
			gravity = Gravity.CENTER
			visibility = View.GONE
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
			addView(codeField, wide)
			addView(portField, wide)
			addView(devSwitch, wide)
		}
		root.addView(inkFrame, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
		root.addView(status, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
		setContentView(root)
		// The page opens its drawer with a swipe from a strip on the left edge (components/sidebar.tsx: 24px wide, 180px tall, from
		// the middle of the screen down). Android's back gesture owns the screen edges, so that strip is exempt from it; the
		// rest of the edge, and the right edge, still go back.
		root.addOnLayoutChangeListener { v, _, top, _, bottom, _, _, _, _ ->
			val middle = (bottom - top) / 2
			ViewCompat.setSystemGestureExclusionRects(v, listOf(Rect(0, middle, dp(32), middle + dp(180))))
		}

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

	private fun show(titleText: String, detailText: String, primaryLabel: String?, onPrimary: () -> Unit, secondaryLabel: String? = null, onSecondary: () -> Unit = {}, controls: Boolean = true, code: Boolean = false) {
		pageShown = false
		codeField.visibility = if (code) View.VISIBLE else View.GONE
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

	private fun askMicrophone(onResult: (Boolean) -> Unit) {
		if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
			onResult(true)
		} else {
			speechMicCallback = onResult
			speechMic.launch(Manifest.permission.RECORD_AUDIO)
		}
	}

	private fun openAppSettings() {
		startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
	}

	// ── flow ─────────────────────────────────────────────────────────────────

	/** Look at the server and the guest, then do the one next thing (Logic.kt: Flow.decide). */
	private fun begin(afterStart: Boolean = false) {
		if (busy) return
		busy = true
		val my = ++attempt
		showWorking(if (dev) "Connecting to the dev server…" else "Connecting…")
		val p = port
		thread {
			val healthy = !dev && checkHealth(p)
			// the guest is only looked at when nothing answers: a running server needs no checks
			val down = !dev && !healthy
			val installed = !down || provisioner.installed()
			val signedIn = !down || !installed || login.loggedIn()
			runOnUiThread {
				if (my != attempt) return@runOnUiThread
				busy = false
				// an update is not a step of its own: the app opens first and the page's card offers it (checkForUpdate)
				when (Flow.decide(dev, healthy, installed, signedIn)) {
					Next.Load -> load()
					Next.Provision -> provision()
					Next.Login -> startLogin()
					// the server was started and still does not answer: asking again would loop forever
					Next.Start -> if (afterStart) {
						show(
							"The server does not start",
							Redact.tokens(serverLogTail()).ifBlank { "It printed nothing. Try again, or reopen the app." },
							"Try again", ::retry,
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

	/**
	 * After the page is up: is there a newer release? Looked at once per cold start, off the UI thread (4 s timeout). The page's
	 * update card offers it (`update probe` / `update available`), so the app is never held back by the question.
	 */
	private fun checkForUpdate() {
		if (dev || updateChecked || skipUpdate) return
		updateChecked = true
		thread {
			val ready = provisioner.updateAvailable(provisioner.remoteVersions(timeoutMs = 4_000))
			runOnUiThread {
				updateReady = ready && !skipUpdate
				if (updateReady) updateReply?.invoke(UpdateWire.AVAILABLE)
				// an installed server older than the card never probes, and could not be updated at all: say it on our own screen
				if (updateReady) root.postDelayed({ if (updateReady && !updateProbed && pageShown) offerUpdateOnShellScreen() }, NO_CARD_AFTER_MS)
			}
		}
	}

	private fun offerUpdateOnShellScreen() {
		show(
			"Update available",
			"A newer version of the learning environment is ready. It downloads over Wi-Fi.",
			"Update now", ::startUpdate,
			"Later", { skipUpdate = true; updateReady = false; begin() },
			controls = false,
		)
	}

	private fun onUpdateOp(op: UpdateOp, reply: (String) -> Unit) {
		when (op) {
			UpdateOp.Probe -> {
				updateProbed = true
				updateReply = reply
				if (updateReady) reply(UpdateWire.AVAILABLE)
			}
			UpdateOp.Later -> {
				skipUpdate = true
				updateReady = false
			}
			UpdateOp.Start -> runOnUiThread { startUpdate() }
		}
	}

	/** "Update" on the card: nothing is downloaded over a metered connection (owner decision, M12); the server stops first, because the files under it are replaced. */
	private fun startUpdate() {
		if (busy) return
		// if the state cannot be read, assume the worst: a metered connection
		val metered = try {
			getSystemService(ConnectivityManager::class.java).isActiveNetworkMetered
		} catch (_: SecurityException) {
			true
		}
		if (metered) {
			show(
				"Connect to Wi-Fi",
				"The update is only downloaded on Wi-Fi. Connect, then try again.",
				"Try again", ::startUpdate,
				"Later", { skipUpdate = true; updateReady = false; begin() },
				controls = false,
			)
		} else {
			stopThenProvision()
		}
	}

	private fun stopThenProvision() {
		busy = true
		showWorking("Stopping the server…")
		thread {
			ServerService.stop(this)
			Thread.sleep(2500) // the service gives node up to 1.5 s to exit
			runOnUiThread {
				busy = false
				updateReady = false
				provision()
			}
		}
	}

	/** First run, or an update: download and unpack the guest and the server. The screen stays on (a download must not be cut short). */
	private fun provision() {
		busy = true
		window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
		showWorking("Setting up…")
		detail.text = "Downloading the learning environment. This happens once; keep the app open."
		// the download and the unpacking must go on with the screen off or locked
		val wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lh:setup").also { it.acquire(60 * 60 * 1000L) }
		thread {
			val failure = try {
				provisioner.run { label, pct ->
					runOnUiThread {
						title.text = label
						detail.text = pct?.let { "$it %" } ?: ""
					}
				}
				null
			} catch (e: Provisioner.Failure) {
				e.message ?: "Setup failed."
			} catch (e: Exception) {
				"Setup failed (${e.javaClass.simpleName}: ${e.message})."
			}
			if (wake.isHeld) wake.release()
			// what failed, for diagnosis without a screen (the status screen shows it too)
			if (failure != null) File(filesDir, "setup.log").appendText(System.currentTimeMillis().toString() + " " + Redact.tokens(failure) + "\n")
			runOnUiThread {
				busy = false
				window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
				if (failure == null) begin() else show("Setup did not finish", Redact.tokens(failure), "Try again", ::retry)
			}
		}
	}

	/** Claude's sign-in: the link opens in the browser, the page shows a code, the learner pastes it here. */
	private fun startLogin() {
		loginActive = true
		loginUrl = null
		show(
			"Sign in to Claude",
			"Preparing the sign-in…",
			"Open the sign-in page", { loginUrl?.let { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it))) } },
			"Submit the code", ::submitCode,
			controls = false, code = true,
		)
		primary.isEnabled = false
		codeField.setText("")
		login.start(
			onUrl = { url ->
				runOnUiThread {
					loginUrl = url
					primary.isEnabled = true
					detail.text = "Open the sign-in page, sign in with the Claude account, then copy the code it shows and paste it below."
				}
			},
			onDone = { ok ->
				runOnUiThread {
					loginActive = false
					if (ok) begin() else show("Sign-in did not finish", "The code was refused or the sign-in timed out.", "Try again", ::startLogin)
				}
			},
		)
	}

	private fun submitCode() {
		val code = codeField.text.toString()
		if (code.isBlank()) return
		login.submit(code)
		detail.text = "Signing in…"
	}

	private fun startServer() {
		busy = true
		showWorking("Starting the server…")
		detail.text = "This takes a few seconds."
		if (!askedNotifications && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
			askedNotifications = true
			busy = false
			notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
			return
		}
		// a fresh install (no settings file yet) starts with the Claude models picked; a saved choice is never touched
		File(guest.home, "lh-data").mkdirs()
		File(guest.home, "lh-data/settings.json").let { if (!it.exists()) it.writeText(FirstRun.MODELS_SETTINGS) }
		ServerService.start(this, port)
		val p = port
		thread {
			val deadline = System.currentTimeMillis() + START_TIMEOUT_MS
			while (System.currentTimeMillis() < deadline && !checkHealth(p)) Thread.sleep(500)
			runOnUiThread {
				busy = false
				begin(afterStart = true)
			}
		}
	}

	private fun serverLogTail(): String = try {
		File(filesDir, "server.log").readText().takeLast(500)
	} catch (_: Exception) {
		""
	}

	/** Pair when there is no cookie, then load. */
	private fun load() {
		if (dev || hasCookie()) {
			open()
			return
		}
		pair()
		open()
	}

	private fun hasCookie(): Boolean =
		CookieManager.getInstance().getCookie(Server.base(port))?.contains("${Server.COOKIE}=") == true

	/** The cookie the server would have set when asked to pair; the token is ours, so no round trip is needed. */
	private fun pair() {
		CookieManager.getInstance().apply {
			setCookie(Server.base(port), Server.cookie(tokens.get()))
			flush()
		}
	}

	/** A new token and a restarted server: the way out of "the server refuses this app". */
	private fun resetPairing() {
		busy = true
		showWorking("Resetting the pairing…")
		thread {
			ServerService.stop(this)
			tokens.rotate()
			Thread.sleep(2500)
			runOnUiThread {
				CookieManager.getInstance().apply {
					removeAllCookies(null)
					flush()
				}
				rePaired = false
				busy = false
				begin()
			}
		}
	}

	private fun open() {
		pageShown = true
		saw403 = false
		status.visibility = View.GONE
		webView.visibility = View.VISIBLE
		updateProbed = false
		webView.loadUrl(Server.base(port))
		checkForUpdate()
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
			speech.close() // nor is it listening
		}

		override fun onPageFinished(view: WebView, url: String?) {
			if (url == null || !Server.isInternal(url, port)) return
			view.evaluateJavascript(insetsScript + DOWNLOAD_HOOK, null)
			if (!saw403) rePaired = false
		}

		override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
			if (!request.isForMainFrame || errorResponse.statusCode != 403 || dev) return
			saw403 = true
			// "Not paired": the cookie is gone or the server runs with another token. Write the cookie again once.
			if (rePaired) {
				show("Pairing failed", "The server still refuses this app.", "Reset the pairing", ::resetPairing, "Try again", ::retry)
				return
			}
			rePaired = true
			CookieManager.getInstance().apply {
				removeAllCookies(null)
				flush()
			}
			if (!busy) {
				pair()
				open()
			}
		}

		override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
			if (!request.isForMainFrame) return
			show("The server is not reachable", error.description.toString(), "Try again", ::retry)
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
		login.cancel()
		WebViewCompat.removeWebMessageListener(webView, "lhShell")
		inkBridge.remove()
		super.onDestroy()
	}

	private companion object {
		const val BACKGROUND = 0xFF151210.toInt()
		/** How long a freshly started server may take before the shell reads its log and reports. */
		const val START_TIMEOUT_MS = 90_000L
		/** After the check found an update: how long the page may stay silent before the shell offers it on its own screen. */
		const val NO_CARD_AFTER_MS = 8_000L

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
