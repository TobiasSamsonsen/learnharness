package dev.learnharness.android

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper

/** What Termux reports for one RUN_COMMAND (the `result` bundle), or why there is none. */
class TermuxReply(
	val exitCode: Int?,
	val stdout: String,
	val stderr: String,
	val err: Int?,
	val errmsg: String?,
) {
	val problem: TermuxProblem get() = TermuxResult.problem(exitCode, err, errmsg, stderr)
}

/**
 * Runs `lh …` in Termux through its RUN_COMMAND service (background, no terminal) and returns the
 * result to a callback on the main thread. The token travels back in the result bundle only: it is
 * never on a command line.
 */
object Termux {
	const val PACKAGE = "com.termux"
	const val PERMISSION = "com.termux.permission.RUN_COMMAND"
	const val LH = "/data/data/com.termux/files/usr/bin/lh"

	private const val ACTION = "com.termux.RUN_COMMAND"
	private const val SERVICE = "com.termux.app.RunCommandService"
	private const val EXTRA_PATH = "com.termux.RUN_COMMAND_PATH"
	private const val EXTRA_ARGUMENTS = "com.termux.RUN_COMMAND_ARGUMENTS"
	private const val EXTRA_BACKGROUND = "com.termux.RUN_COMMAND_BACKGROUND"
	private const val EXTRA_LABEL = "com.termux.RUN_COMMAND_COMMAND_LABEL"
	private const val EXTRA_PENDING_INTENT = "com.termux.RUN_COMMAND_PENDING_INTENT"
	internal const val EXTRA_CALL_ID = "dev.learnharness.android.CALL_ID"

	private val main = Handler(Looper.getMainLooper())
	private val waiting = HashMap<Int, (TermuxReply) -> Unit>()
	private var nextId = 1

	fun installed(context: Context): Boolean = try {
		context.packageManager.getPackageInfo(PACKAGE, 0)
		true
	} catch (_: PackageManager.NameNotFoundException) {
		false
	}

	fun permissionGranted(context: Context): Boolean =
		context.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED

	/** `onReply` runs once on the main thread: with Termux's result, or with a synthetic one on a timeout or a refused call. */
	fun run(context: Context, args: List<String>, timeoutMs: Long, onReply: (TermuxReply) -> Unit) {
		val id = nextId++
		waiting[id] = onReply
		val result = PendingIntent.getBroadcast(
			context,
			id,
			Intent(context, TermuxResultReceiver::class.java).putExtra(EXTRA_CALL_ID, id),
			PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_MUTABLE,
		)
		val intent = Intent(ACTION)
			.setComponent(ComponentName(PACKAGE, SERVICE))
			.putExtra(EXTRA_PATH, LH)
			.putExtra(EXTRA_ARGUMENTS, args.toTypedArray())
			.putExtra(EXTRA_BACKGROUND, true)
			.putExtra(EXTRA_LABEL, "lh ${args.joinToString(" ")}")
			.putExtra(EXTRA_PENDING_INTENT, result)
		try {
			context.startService(intent)
		} catch (e: Exception) { // SecurityException when the permission is off, IllegalStateException when we are not allowed to start it
			deliver(id, TermuxReply(null, "", "", 1, e.message ?: e.javaClass.simpleName))
			return
		}
		main.postDelayed({ deliver(id, TermuxReply(null, "", "", -2, "no answer from Termux in ${timeoutMs / 1000} s")) }, timeoutMs)
	}

	internal fun deliver(id: Int, reply: TermuxReply) {
		main.post { waiting.remove(id)?.invoke(reply) }
	}
}

class TermuxResultReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		val id = intent.getIntExtra(Termux.EXTRA_CALL_ID, -1)
		val bundle = intent.getBundleExtra("result")
		fun int(key: String): Int? = if (bundle?.containsKey(key) == true) bundle.getInt(key) else null
		Termux.deliver(
			id,
			TermuxReply(
				exitCode = int("exitCode"),
				stdout = bundle?.getString("stdout").orEmpty(),
				stderr = bundle?.getString("stderr").orEmpty(),
				err = int("err"),
				errmsg = bundle?.getString("errmsg"),
			),
		)
	}
}
