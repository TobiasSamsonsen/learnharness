package dev.learnharness.android

import android.content.Context
import android.net.ConnectivityManager
import java.io.File

/**
 * The Linux guest (Ubuntu + Node + claude, docs/android/m12-plan.md): where it lives and how to run something in it.
 * `proot` and its loader are shipped as lib*.so (jniLibs, see scripts/fetch-proot.py) because Android only executes
 * files from the native library directory. Three things live outside the replaceable rootfs and are bound into it:
 * the learner's home (`/root`: Claude's login, `lh-data`), the server bundle (`/opt/lh/server`) and a staging
 * directory for downloads (`/staging`). The claude CLI is installed under the home (`/root/.local`), so a rootfs update keeps it.
 */
class Guest(context: Context) {
	private val appContext = context.applicationContext
	private val libDir = context.applicationInfo.nativeLibraryDir
	private val tmpDir = File(context.cacheDir, "proot")
	val rootfs = File(context.filesDir, "rootfs")
	val home = File(context.filesDir, "home")
	val server = File(context.filesDir, "server")
	val staging = File(context.filesDir, "staging")

	/** A process that runs `argv` in the guest; the caller starts it and owns its streams. */
	fun command(argv: List<String>, env: Map<String, String> = emptyMap(), workdir: String = "/root"): ProcessBuilder {
		listOf(home, server, staging, tmpDir).forEach { it.mkdirs() }
		// the bind targets inside the rootfs (a freshly unpacked image has them; this covers one that does not)
		listOf("root", "opt/lh/server", "staging").forEach { File(rootfs, it).mkdirs() }
		val pb = ProcessBuilder(
			ProotCommand.args(
				proot = "$libDir/libproot.so",
				rootfs = rootfs.path,
				binds = listOf("/dev" to "/dev", "/proc" to "/proc", home.path to "/root", server.path to "/opt/lh/server", staging.path to "/staging"),
				workdir = workdir,
				env = ProotCommand.GUEST_ENV + env,
				argv = argv,
			),
		)
		pb.environment().apply {
			put("LD_LIBRARY_PATH", libDir)
			put("PROOT_LOADER", "$libDir/libproot-loader.so")
			put("PROOT_TMP_DIR", tmpDir.path)
		}
		return pb
	}

	/** Writes the phone's current resolvers into the guest (Android has no /etc/resolv.conf); a network change needs another call. */
	@Synchronized
	fun refreshDns(known: List<String>? = null) {
		val servers = known ?: try {
			val cm = appContext.getSystemService(ConnectivityManager::class.java)
			cm.getLinkProperties(cm.activeNetwork)?.dnsServers?.mapNotNull { it.hostAddress }.orEmpty()
		} catch (_: SecurityException) {
			emptyList()
		}
		File(rootfs, "etc").mkdirs()
		// Written aside and renamed over, so a guest process never reads a half-written file; the rename also replaces a
		// dangling symlink from the image.
		val tmp = File(rootfs, "etc/resolv.conf.new")
		tmp.writeText(ResolvConf.render(servers))
		if (!tmp.renameTo(File(rootfs, "etc/resolv.conf"))) throw java.io.IOException("could not replace resolv.conf")
	}

	/**
	 * Runs `argv` to the end and returns its exit code and output (stdout and stderr together). With [timeoutMs] above 0 a command that
	 * has not finished by then is killed and the code is [ProcessRun.TIMED_OUT] (the output so far is returned).
	 */
	fun run(argv: List<String>, env: Map<String, String> = emptyMap(), workdir: String = "/root", timeoutMs: Long = 0): Pair<Int, String> {
		val p = command(argv, env, workdir).redirectErrorStream(true).start()
		p.outputStream.close()
		// proot does not take the guest command with it when killed, so a timeout kills the whole tree
		return ProcessRun.collect(p, timeoutMs) { GuestProcesses.killTree(it, 1000) }
	}
}

/** Reading a process to its end, with an optional time limit; pure of Android, so the unit tests cover it. */
object ProcessRun {
	/** The exit code reported for a command that was killed for taking too long. */
	const val TIMED_OUT = -9999

	/**
	 * The process's output and exit code. The output is read on a thread of its own so the wait can give up: a guest child that keeps the
	 * pipe open (proot does not take its tracees with it when killed) must not hold the caller forever. After a timeout [kill] ends the
	 * process and the reader is left to end by itself.
	 */
	fun collect(p: Process, timeoutMs: Long, kill: (Process) -> Unit = { it.destroyForcibly() }): Pair<Int, String> {
		val out = StringBuffer()
		val reader = Thread({
			try {
				p.inputStream.bufferedReader().use { r ->
					val buffer = CharArray(4096)
					while (true) {
						val n = r.read(buffer)
						if (n < 0) break
						out.append(buffer, 0, n)
					}
				}
			} catch (_: java.io.IOException) {
				// the process was killed under the reader: what was read stands
			}
		}, "guest-output").also { it.isDaemon = true; it.start() }
		if (timeoutMs > 0 && !p.waitFor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)) {
			kill(p)
			return TIMED_OUT to out.toString()
		}
		val code = p.waitFor()
		reader.join(2000) // the rest of the output is already in the pipe
		return code to out.toString()
	}
}

/** The proot command line; pure, so the unit tests cover it. */
object ProotCommand {
	/** What every guest process starts with: a clean environment (the device's would leak Android paths in). */
	val GUEST_ENV = mapOf(
		"HOME" to "/root",
		"PATH" to "/root/.local/bin:/opt/node/bin:/usr/bin:/bin",
		"TMPDIR" to "/tmp",
		"LANG" to "C.UTF-8",
	)

	fun args(proot: String, rootfs: String, binds: List<Pair<String, String>>, workdir: String, env: Map<String, String>, argv: List<String>): List<String> =
		buildList {
			add(proot)
			// --kill-on-exit: the guest's processes die with proot. --link2symlink: Android's filesystem has no hard links for us.
			add("--kill-on-exit")
			add("--link2symlink")
			add("-r")
			add(rootfs)
			binds.forEach { (host, guest) ->
				add("-b")
				add("$host:$guest")
			}
			add("-w")
			add(workdir)
			add("/usr/bin/env")
			add("-i")
			env.forEach { (k, v) -> add("$k=$v") }
			addAll(argv)
		}
}
