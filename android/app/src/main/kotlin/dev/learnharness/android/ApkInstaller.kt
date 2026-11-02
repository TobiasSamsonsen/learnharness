package dev.learnharness.android

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File

/**
 * Installs the app's own new APK through a PackageInstaller session (the update card's app update). The APK's bytes are
 * streamed into the session, so no FileProvider is needed. `USER_ACTION_NOT_REQUIRED` lets Android 12+ replace the app
 * without a confirmation once this app was the one that installed it; otherwise the system asks once, and the answer
 * comes back through [onResult] (the process is normally replaced before a success is seen).
 */
class ApkInstaller(private val context: Context, private val onResult: (Result) -> Unit) {
	sealed interface Result {
		/** The system wants the learner's confirmation; this is its screen. */
		data class NeedsConfirm(val intent: Intent) : Result
		data class Failed(val message: String) : Result
		data object Done : Result
	}

	private val action = "${context.packageName}.APK_INSTALL_RESULT"
	private var receiver: BroadcastReceiver? = null

	/** "Install unknown apps" is allowed for this app (a per-app switch the learner turns on once). */
	fun canInstall(): Boolean = context.packageManager.canRequestPackageInstalls()

	/** Blocking IO (the copy into the session): call off the UI thread. Throws on a session that cannot be written. */
	fun install(apk: File) {
		val installer = context.packageManager.packageInstaller
		val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
			setAppPackageName(context.packageName)
			setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
			setSize(apk.length())
		}
		listen()
		val id = installer.createSession(params)
		installer.openSession(id).use { session ->
			apk.inputStream().use { input ->
				session.openWrite("base.apk", 0, apk.length()).use { out ->
					input.copyTo(out)
					session.fsync(out)
				}
			}
			// mutable: the system adds the status extras to this intent
			val pending = PendingIntent.getBroadcast(
				context, id, Intent(action).setPackage(context.packageName),
				PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
			)
			session.commit(pending.intentSender)
		}
	}

	private fun listen() {
		if (receiver != null) return
		val r = object : BroadcastReceiver() {
			override fun onReceive(c: Context, intent: Intent) {
				val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
				when (status) {
					PackageInstaller.STATUS_PENDING_USER_ACTION -> {
						val confirm = if (Build.VERSION.SDK_INT >= 33) {
							intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
						} else {
							@Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
						}
						onResult(if (confirm != null) Result.NeedsConfirm(confirm) else Result.Failed(InstallStatus.message(status, "no confirmation screen")))
					}
					PackageInstaller.STATUS_SUCCESS -> onResult(Result.Done)
					else -> onResult(Result.Failed(InstallStatus.message(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))))
				}
			}
		}
		context.registerReceiver(r, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
		receiver = r
	}

	/** Stop listening (the activity is going away, or the install ended). */
	fun stop() {
		receiver?.let { runCatching { context.unregisterReceiver(it) } }
		receiver = null
	}
}
