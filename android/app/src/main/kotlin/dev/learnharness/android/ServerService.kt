package dev.learnharness.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.system.OsConstants
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom

/**
 * The server, supervised (docs/android/m12-plan.md, step 2): a foreground service that runs `node server.js` in the guest
 * as a direct child of the app (the M12 spike showed such a tree survives a screen-off, deep-idle half hour), holds a
 * partial wake lock while it runs and restarts the server if it dies. proot is started directly, never through a shell,
 * so the guest costs as few of Android's phantom-process slots as possible.
 *
 * An unused server rests (IdlePolicy, owner decision 2026-11-03): nothing in use for 10 minutes drops the wake lock, 45 minutes
 * stops the service. "In use" is the app on screen, or the server reporting work in progress (GET /api/busy), so a long turn or a
 * long problem is never cut. The app starts the server again on its next open (MainActivity.onResume checks it is up).
 */
class ServerService : Service() {
	private var wake: PowerManager.WakeLock? = null
	private val wakeGuard = Any()
	private var supervisor: Thread? = null
	private var monitor: Thread? = null
	@Volatile private var stopping = false
	@Volatile private var process: Process? = null
	private var bridge: DemoBridge? = null

	override fun onBind(intent: Intent?): IBinder? = null

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
		val nm = getSystemService(NotificationManager::class.java)
		nm.createNotificationChannel(NotificationChannel(CHANNEL, "Server", NotificationManager.IMPORTANCE_LOW))
		val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
		val note = Notification.Builder(this, CHANNEL)
			.setContentTitle("learnharness is running")
			.setContentText("The learning server stays up while this is shown. It rests by itself when unused.")
			.setSmallIcon(R.mipmap.ic_launcher_monochrome)
			.setContentIntent(open)
			.setOngoing(true)
			.build()
		startForeground(NOTIFICATION_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
		instance = this
		ensureWakeLock()
		if (intent?.action == ACTION_STOP) {
			stopServer()
			stopSelf()
			return START_NOT_STICKY
		}
		val port = intent?.getIntExtra(EXTRA_PORT, Server.DEFAULT_PORT) ?: Server.DEFAULT_PORT
		if (supervisor?.isAlive != true) {
			stopping = false
			supervisor = Thread({
				try {
					supervise(port)
				} catch (e: Exception) {
					// e.g. proot could not be started: say so where the status screen reads, and stop
					File(filesDir, "server.log").appendText("supervisor failed: " + e + System.lineSeparator())
					stopSelf()
				}
			}, "server-supervisor").also { it.start() }
		}
		if (monitor?.isAlive != true) {
			monitor = Thread({
				try {
					watch(port)
				} catch (e: Exception) {
					File(filesDir, "server.log").appendText("idle monitor failed: " + e + System.lineSeparator())
				}
			}, "idle-monitor").also { it.start() }
		}
		return START_NOT_STICKY
	}

	private fun ensureWakeLock() = synchronized(wakeGuard) {
		val w = wake ?: getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lh:server").also { wake = it }
		if (!w.isHeld) w.acquire()
	}

	private fun releaseWakeLock() = synchronized(wakeGuard) {
		wake?.let { if (it.isHeld) it.release() }
	}

	/**
	 * Rests an unused server. Idle is the app off screen AND the server not busy; any sign of use restarts the clock and takes the
	 * wake lock back. An answer from the server that is not a busy report counts as in use (a starting server, an error page).
	 */
	private fun watch(port: Int) {
		val token = TokenStore(File(filesDir, "token")).get()
		val limits = IdlePolicy.limitsFrom(File(filesDir, "idle-limits").takeIf { it.isFile }?.readText())
		lastActiveAt = SystemClock.elapsedRealtime()
		while (!stopping) {
			try {
				Thread.sleep(limits.pollMs)
			} catch (_: InterruptedException) {
				return
			}
			val now = SystemClock.elapsedRealtime()
			if (appVisible || serverBusy(port, token) != false) {
				lastActiveAt = now
				ensureWakeLock()
				continue
			}
			val idle = now - lastActiveAt
			if (!IdlePolicy.holdWakeLock(idle, limits)) releaseWakeLock()
			if (IdlePolicy.step(idle, limits) == IdlePolicy.Step.STOP) {
				File(filesDir, "server.log").appendText("unused for ${idle / 1000} seconds: stopping the server" + System.lineSeparator())
				stopServer()
				stopSelf()
				return
			}
		}
	}

	/** Does the server say it is working? null when it could not be asked or did not answer with a report. */
	private fun serverBusy(port: Int, token: String): Boolean? = try {
		val c = URL(ServerBusy.url(port)).openConnection() as HttpURLConnection
		c.connectTimeout = 3000
		c.readTimeout = 3000
		c.useCaches = false
		c.setRequestProperty("Cookie", ServerBusy.cookieHeader(token))
		try {
			if (c.responseCode == 200) ServerBusy.parse(c.inputStream.bufferedReader().use { it.readText() }) else null
		} finally {
			c.disconnect()
		}
	} catch (_: Exception) {
		null
	}

	/** Runs the server; restarts it when it dies, but gives up when it keeps dying right away. */
	private fun supervise(port: Int) {
		val guest = Guest(this)
		val token = TokenStore(File(filesDir, "token")).get()
		File(guest.home, ".lh").mkdirs()
		File(guest.home, "lh-data").mkdirs()
		val log = File(filesDir, "server.log")
		// the demo browser: the server runs demos in the shell's WebView through this loopback service (M12 step 5)
		val bridgeToken = Token.fromBytes(ByteArray(24).also { SecureRandom().nextBytes(it) })
		val demo = DemoBridge(applicationContext, bridgeToken).also { it.start() }
		bridge = demo
		val starts = ArrayDeque<Long>()
		while (!stopping) {
			val now = System.currentTimeMillis()
			starts.addLast(now)
			while (starts.isNotEmpty() && now - starts.first() > RESTART_WINDOW_MS) starts.removeFirst()
			if (starts.size > MAX_RESTARTS) break
			guest.refreshDns()
			val p = guest.command(listOf("node", "server.js"), ServerEnv.of(port, token, demo.port, bridgeToken), workdir = "/opt/lh/server")
				.redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(log)).start()
			p.outputStream.close()
			process = p
			p.waitFor()
			if (!stopping) Thread.sleep(1000L shl (starts.size - 1).coerceIn(0, 4))
		}
		if (!stopping) stopSelf()
	}

	/**
	 * Stops the server for real. proot ignores SIGTERM and does not take its tracees with it when it is killed (seen on a Pixel 7 Pro,
	 * 2026-11-03: the Node server kept serving, orphaned), so the guest's whole process tree is signalled: TERM first so Node can
	 * finish, then KILL for what is still there, and proot last.
	 */
	private fun stopServer() {
		stopping = true
		val p = process ?: return
		val tree = ProcessTree.descendants(pidOf(p) ?: return p.destroyForcibly().let { Unit }, procParents())
		tree.forEach { signal(it, OsConstants.SIGTERM) }
		p.destroy()
		val deadline = System.currentTimeMillis() + 4000
		while (System.currentTimeMillis() < deadline && tree.any { alive(it) }) Thread.sleep(100)
		tree.filter { alive(it) }.forEach { signal(it, OsConstants.SIGKILL) }
		if (p.isAlive) p.destroyForcibly()
	}

	/** The proot process's pid: Process.pid() from Android 13; before that, the app's child whose command line runs the server. */
	private fun pidOf(p: Process): Int? {
		if (Build.VERSION.SDK_INT >= 33) {
			try {
				return (Process::class.java.getMethod("pid").invoke(p) as Long).toInt()
			} catch (_: Exception) {
				// fall through to the scan
			}
		}
		val me = android.os.Process.myPid()
		return procParents().filterValues { it == me }.keys.firstOrNull { pid ->
			try {
				File("/proc/$pid/cmdline").readText().contains("server.js")
			} catch (_: Exception) {
				false
			}
		}
	}

	/** pid -> parent pid for every process this app may see (its own uid's: the app and its guest). */
	private fun procParents(): Map<Int, Int> {
		val out = HashMap<Int, Int>()
		File("/proc").list()?.forEach { name ->
			val pid = name.toIntOrNull() ?: return@forEach
			try {
				ProcessTree.parentOf(File("/proc/$pid/stat").readText())?.let { out[pid] = it }
			} catch (_: Exception) {
				// gone, or not ours to read
			}
		}
		return out
	}

	/** Still running (a zombie is gone as far as the server is concerned: it holds no port). */
	private fun alive(pid: Int): Boolean = try {
		val stat = File("/proc/$pid/stat").readText()
		stat.substring(stat.lastIndexOf(')') + 1).trim().firstOrNull().let { it != null && it != 'Z' && it != 'X' }
	} catch (_: Exception) {
		false
	}

	private fun signal(pid: Int, sig: Int) {
		try {
			android.os.Process.sendSignal(pid, sig)
		} catch (_: Exception) {
			// already gone
		}
	}

	override fun onDestroy() {
		stopServer()
		monitor?.interrupt()
		bridge?.stop()
		releaseWakeLock()
		if (instance === this) instance = null
		super.onDestroy()
	}

	companion object {
		const val ACTION_STOP = "dev.learnharness.android.STOP"
		private const val EXTRA_PORT = "port"
		private const val CHANNEL = "server"
		private const val NOTIFICATION_ID = 1
		private const val RESTART_WINDOW_MS = 120_000L
		private const val MAX_RESTARTS = 5

		/** The running service, so the activity can wake it the moment the app is used again. */
		@Volatile private var instance: ServerService? = null

		/** The app is on screen: the server is in use, whatever it reports. */
		@Volatile private var appVisible = false

		/** When something was last in use (SystemClock.elapsedRealtime, which counts deep sleep). */
		@Volatile private var lastActiveAt = 0L

		/** MainActivity calls this from onResume (true) and onPause (false). Showing the app takes the wake lock back at once. */
		fun onAppVisible(visible: Boolean) {
			appVisible = visible
			lastActiveAt = SystemClock.elapsedRealtime()
			if (visible) instance?.ensureWakeLock()
		}

		fun start(context: Context, port: Int) {
			context.startForegroundService(Intent(context, ServerService::class.java).putExtra(EXTRA_PORT, port))
		}

		fun stop(context: Context) {
			context.startService(Intent(context, ServerService::class.java).setAction(ACTION_STOP))
		}
	}
}

/** The pairing token: made once, kept in the app's private storage, handed to the server by environment. */
class TokenStore(private val file: File) {
	fun get(): String = Token.parse(if (file.isFile) file.readText() else null) ?: rotate()

	/** A new token; the old one (and every cookie made from it) stops working once the server restarts. */
	fun rotate(): String {
		val bytes = ByteArray(24).also { SecureRandom().nextBytes(it) }
		val token = Token.fromBytes(bytes)
		file.writeText(token + "\n")
		file.setReadable(false, false)
		file.setReadable(true, true)
		return token
	}
}
