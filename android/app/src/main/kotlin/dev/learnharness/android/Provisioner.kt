package dev.learnharness.android

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest

/**
 * First run and updates (docs/android/m12-plan.md, step 1): downloads the two release assets (from two rolling releases), checks their sha256 and
 * unpacks them. The rootfs (Ubuntu + Node + the pinned claude) is unpacked with Android's own `tar`; the server bundle
 * is a .tar.zst, so it is unpacked inside the guest, which carries `zstd`. The claude CLI is not in either: it is installed from npm,
 * at the version the app pins (Release.CLAUDE_VERSION), into the home. Each asset has a one-line version file next
 * to it; the installed versions are kept in `rootfs.version` and `server.version`, and a differing remote version means
 * "update". The learner's home and the server directory sit outside the rootfs, so a rootfs update keeps the login.
 */
class Provisioner(private val guest: Guest, private val stateDir: File, private val rootfsBase: String, private val serverBase: String) {
	class Failure(message: String) : Exception(message)

	private val rootfsMarker = File(stateDir, "rootfs.version")
	private val serverMarker = File(stateDir, "server.version")
	private val claudeMarker = File(stateDir, "claude.version")

	/** The rootfs, the server and claude are all installed (whatever their version). */
	fun installed(): Boolean = rootfsMarker.isFile && serverMarker.isFile && File(guest.server, "server.js").isFile && claudeMarker.isFile

	/** The pinned claude CLI is installed (a local check: the pin lives in the app, not in a release). */
	private fun claudeCurrent(): Boolean = read(claudeMarker) == Release.CLAUDE_VERSION

	/** The release's versions, or null for one that cannot be read (offline). */
	fun remoteVersions(timeoutMs: Int = 15_000): Pair<String?, String?> =
		Release.parseVersion(fetchText(rootfsBase, Release.ROOTFS_VERSION, timeoutMs)) to Release.parseVersion(fetchText(serverBase, Release.SERVER_VERSION, timeoutMs))

	/** True when something is installed but the release has a different version of a part (or the app pins another claude). */
	fun updateAvailable(remote: Pair<String?, String?>): Boolean =
		installed() && (!claudeCurrent() || Release.outdated(read(rootfsMarker), remote.first) || Release.outdated(read(serverMarker), remote.second))

	/** Blocking; `progress` gets a label and, while a download runs, a percentage. Throws [Failure] with a message for the screen. */
	fun run(progress: (String, Int?) -> Unit) {
		val remote = remoteVersions()
		val rootfsVersion = remote.first
		val serverVersion = remote.second
		val rootfsMissing = !rootfsMarker.isFile || !File(guest.rootfs, "usr/bin/env").exists()
		val serverMissing = !serverMarker.isFile || !File(guest.server, "server.js").isFile
		if ((rootfsMissing || serverMissing) && (rootfsVersion == null || serverVersion == null)) {
			throw Failure("The download could not be reached. Check the internet connection and try again.")
		}
		stateDir.mkdirs()
		guest.staging.mkdirs()
		if (rootfsMissing || Release.outdated(read(rootfsMarker), rootfsVersion)) installRootfs(rootfsVersion!!, progress)
		if (serverMissing || Release.outdated(read(serverMarker), serverVersion)) installServer(serverVersion!!, progress)
		if (!claudeCurrent()) installClaude(progress)
	}

	/** `npm install` of the pinned claude CLI into the home, straight from the npm registry. */
	private fun installClaude(progress: (String, Int?) -> Unit) {
		progress("Installing Claude", null)
		guest.refreshDns()
		val prefix = "/root/.local"
		val (code, output) = guest.run(
			listOf("npm", "install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", "@anthropic-ai/claude-code@${Release.CLAUDE_VERSION}"),
			mapOf("npm_config_update_notifier" to "false"),
		)
		if (code != 0) throw Failure("Installing Claude failed (npm exit $code). ${Redact.tokens(output.takeLast(300))}")
		val (vcode, version) = guest.run(listOf("claude", "--version"))
		if (vcode != 0 || !version.contains(Release.CLAUDE_VERSION)) {
			throw Failure("Claude did not start after installing (${version.trim().take(200)}).")
		}
		deleteTree(File(guest.home, ".npm")) // npm's download cache is dead weight on a phone
		claudeMarker.writeText(Release.CLAUDE_VERSION + "\n")
	}

	private fun installRootfs(version: String, progress: (String, Int?) -> Unit) {
		val archive = File(guest.staging, Release.ROOTFS)
		download(rootfsBase, Release.ROOTFS, archive, "Downloading the Linux environment", progress)
		progress("Unpacking the Linux environment", null)
		val next = File(stateDir, "rootfs.new")
		deleteTree(next)
		next.mkdirs()
		val (code, output) = tar(listOf("/system/bin/tar", "-xzf", archive.path, "-C", next.path))
		if (code != 0) {
			deleteTree(next)
			throw Failure("Unpacking the Linux environment failed (tar exit $code). ${Redact.tokens(output.takeLast(300))}")
		}
		deleteTree(guest.rootfs)
		if (!next.renameTo(guest.rootfs)) throw Failure("Could not move the unpacked Linux environment into place.")
		archive.delete()
		rootfsMarker.writeText(version + "\n")
	}

	private fun installServer(version: String, progress: (String, Int?) -> Unit) {
		val archive = File(guest.staging, Release.SERVER)
		download(serverBase, Release.SERVER, archive, "Downloading the server", progress)
		progress("Unpacking the server", null)
		val next = File(guest.staging, "server.new")
		deleteTree(next)
		next.mkdirs()
		val (code, output) = guest.run(listOf("tar", "--zstd", "-xf", "/staging/${Release.SERVER}", "-C", "/staging/server.new"))
		if (code != 0 || !File(next, "server.js").isFile) {
			deleteTree(next)
			throw Failure("Unpacking the server failed (exit $code). ${Redact.tokens(output.takeLast(300))}")
		}
		val old = File(stateDir, "server.old")
		deleteTree(old)
		if (guest.server.exists() && !guest.server.renameTo(old)) throw Failure("Could not replace the old server.")
		if (!next.renameTo(guest.server)) {
			old.renameTo(guest.server)
			throw Failure("Could not move the unpacked server into place.")
		}
		deleteTree(old)
		archive.delete()
		serverMarker.writeText(version + "\n")
	}

	/** Downloads `asset` to `target`, checking the sha256 published next to it. */
	private fun download(base: String, asset: String, target: File, label: String, progress: (String, Int?) -> Unit) {
		val expected = Release.parseSha256(fetchText(base, "$asset.sha256")) ?: throw Failure("The download's checksum could not be read.")
		progress(label, 0)
		val digest = MessageDigest.getInstance("SHA-256")
		val c = open(base, asset)
		try {
			if (c.responseCode != 200) throw Failure("The download answered ${c.responseCode}.")
			val total = c.contentLengthLong
			var done = 0L
			var shown = -1
			target.outputStream().use { out ->
				c.inputStream.use { input ->
					val buffer = ByteArray(64 * 1024)
					while (true) {
						val n = input.read(buffer)
						if (n < 0) break
						out.write(buffer, 0, n)
						digest.update(buffer, 0, n)
						done += n
						val pct = if (total > 0) (done * 100 / total).toInt() else null
						if (pct != shown) {
							shown = pct ?: -1
							progress(label, pct)
						}
					}
				}
			}
		} catch (e: IOException) {
			target.delete()
			throw Failure("The download was interrupted (${e.message}). Check the connection and try again.")
		} finally {
			c.disconnect()
		}
		val got = digest.digest().joinToString("") { "%02x".format(it) }
		if (got != expected) {
			target.delete()
			throw Failure("The download is corrupt (checksum mismatch). Try again.")
		}
	}

	/** `connectMs` bounds the connection and, for a download, `readMs` bounds each wait for the next bytes. */
	private fun open(base: String, asset: String, connectMs: Int = 15_000, readMs: Int = 30_000): HttpURLConnection {
		val c = URL(Release.url(base, asset)).openConnection() as HttpURLConnection
		c.connectTimeout = connectMs
		c.readTimeout = readMs
		c.useCaches = false
		return c
	}

	private fun fetchText(base: String, asset: String, timeoutMs: Int = 15_000): String? = try {
		val c = open(base, asset, timeoutMs, timeoutMs) // a short check stays short: version files are a few bytes
		try {
			if (c.responseCode == 200) c.inputStream.bufferedReader().use { it.readText() } else null
		} finally {
			c.disconnect()
		}
	} catch (_: IOException) {
		null
	}

	private fun read(file: File): String? = if (file.isFile) Release.parseVersion(file.readText()) else null

	private fun tar(argv: List<String>): Pair<Int, String> {
		val p = ProcessBuilder(argv).redirectErrorStream(true).start()
		p.outputStream.close()
		val text = p.inputStream.bufferedReader().use { it.readText() }
		return p.waitFor() to text
	}

	/**
	 * Deletes a tree without following symlinks (a guest symlink can point at host paths). A directory is made readable,
	 * writable and searchable BEFORE it is listed: the guest's tree has mode-000 directories, and java.nio's walker opens a
	 * directory before it tells the visitor about it, so a visitor cannot fix the mode in time.
	 */
	private fun deleteTree(entry: File) {
		val path = entry.toPath()
		if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return
		if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
			entry.setReadable(true)
			entry.setWritable(true)
			entry.setExecutable(true)
			entry.listFiles()?.forEach { deleteTree(it) }
		}
		Files.delete(path)
	}
}
