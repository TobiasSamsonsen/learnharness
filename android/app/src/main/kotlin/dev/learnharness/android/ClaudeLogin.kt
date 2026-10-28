package dev.learnharness.android

import java.io.OutputStream

/**
 * Claude sign-in inside the guest (docs/android/m12-plan.md, step 4). `claude auth login` needs a terminal and takes the
 * one-time code from its stdin, so it runs under `script` (a pty) with a pipe we keep open; the sign-in link is read from
 * its output and the code the learner pastes is written back. The M12 spike proved this exact recipe on the phone.
 */
class ClaudeLogin(private val guest: Guest) {
	private var process: Process? = null
	private var stdin: OutputStream? = null

	/** Blocking: asks `claude auth status` (a second or two). */
	fun loggedIn(): Boolean = LoginOutput.loggedIn(guest.run(listOf("claude", "auth", "status")).second)

	/**
	 * Starts the login on a background thread. `onUrl` gets the sign-in link once; `onDone` gets whether it worked.
	 * Both are called from that thread.
	 */
	fun start(onUrl: (String) -> Unit, onDone: (Boolean) -> Unit) {
		cancel()
		val p = guest.command(
			listOf("script", "-qfc", "claude auth login", "/dev/null"),
			mapOf("TERM" to "xterm", "COLUMNS" to "500", "LINES" to "50"),
		).redirectErrorStream(true).start()
		process = p
		stdin = p.outputStream
		Thread({
			val seen = StringBuilder()
			var announced = false
			var ok = false
			val buffer = CharArray(4096)
			try {
				p.inputStream.bufferedReader().use { reader ->
					while (true) {
						val n = reader.read(buffer)
						if (n < 0) break
						seen.append(buffer, 0, n)
						if (!announced) LoginOutput.url(seen.toString())?.let {
							announced = true
							onUrl(it)
						}
						if (LoginOutput.succeeded(seen.toString())) {
							ok = true
							break
						}
					}
				}
			} catch (_: java.io.IOException) {
				// cancel() killed the process under the reader (Stream closed): the login simply ends
			}
			// a login that was cancelled, or replaced by a new attempt, reports nothing
			if (process === p) {
				cancel()
				onDone(ok)
			}
		}, "claude-login").start()
	}

	/** The code the sign-in page shows (it looks like `abc…#xyz…`); spaces from a paste are dropped. */
	fun submit(code: String) {
		val clean = code.filterNot { it.isWhitespace() }
		if (clean.isEmpty()) return
		Thread {
			try {
				stdin?.apply {
					write((clean + "\r").toByteArray())
					flush()
				}
			} catch (_: java.io.IOException) {
				// the login process is already gone; onDone reports it
			}
		}.start()
	}

	fun cancel() {
		process?.destroyForcibly()
		process = null
		stdin = null
	}
}
