package dev.learnharness.android

import android.os.Build
import android.system.OsConstants
import java.io.File

/**
 * Stopping a guest process for real. proot ignores SIGTERM and does not take its tracees with it when it is killed (seen on a
 * Pixel 7 Pro, 2026-11-03: the Node server kept serving, orphaned), so the guest's whole process tree is signalled: TERM first so
 * a program can finish, then KILL for what is still there, and proot last. Shared by the server's stop and a guest command's timeout.
 */
object GuestProcesses {
	/** Ends [p] and everything below it, waiting up to [graceMs] for the TERM to be obeyed. */
	fun killTree(p: Process, graceMs: Long) {
		val root = pidOf(p) ?: return p.destroyForcibly().let { Unit }
		val tree = ProcessTree.descendants(root, procParents())
		tree.forEach { signal(it, OsConstants.SIGTERM) }
		p.destroy()
		val deadline = System.currentTimeMillis() + graceMs
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
}
