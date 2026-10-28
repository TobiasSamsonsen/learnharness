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
import android.os.PowerManager
import java.io.File
import java.security.SecureRandom

/**
 * The server, supervised (docs/android/m12-plan.md, step 2): a foreground service that runs `node server.js` in the guest
 * as a direct child of the app (the M12 spike showed such a tree survives a screen-off, deep-idle half hour), holds a
 * partial wake lock while it runs and restarts the server if it dies. proot is started directly, never through a shell,
 * so the guest costs as few of Android's phantom-process slots as possible.
 */
class ServerService : Service() {
	private var wake: PowerManager.WakeLock? = null
	private var supervisor: Thread? = null
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
			.setContentText("The learning server stays up while this is shown.")
			.setSmallIcon(R.drawable.ic_launcher_foreground)
			.setContentIntent(open)
			.setOngoing(true)
			.build()
		startForeground(NOTIFICATION_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
		if (wake == null) {
			wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lh:server").also { it.acquire() }
		}
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
		return START_NOT_STICKY
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

	private fun stopServer() {
		stopping = true
		process?.let {
			it.destroy()
			Thread.sleep(1500)
			if (it.isAlive) it.destroyForcibly()
		}
	}

	override fun onDestroy() {
		stopServer()
		bridge?.stop()
		wake?.let { if (it.isHeld) it.release() }
		super.onDestroy()
	}

	companion object {
		const val ACTION_STOP = "dev.learnharness.android.STOP"
		private const val EXTRA_PORT = "port"
		private const val CHANNEL = "server"
		private const val NOTIFICATION_ID = 1
		private const val RESTART_WINDOW_MS = 120_000L
		private const val MAX_RESTARTS = 5

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
