package dev.learnharness.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LogicTest {
	private val token = "0123456789abcdef".repeat(3)

	@Test fun tokenIsTheBareHexLine() {
		assertEquals(token, Token.parse("$token\n"))
		assertEquals(token, Token.parse("noise\n$token\n\n"))
	}

	@Test fun tokenRejectsLinksShortValuesAndNothing() {
		assertNull(Token.parse(null))
		assertNull(Token.parse(""))
		assertNull(Token.parse("abc123"))
		assertNull(Token.parse("http://127.0.0.1:3000/?lh_token=$token"))
		assertNull(Token.parse("lh: command not found"))
	}

	@Test fun urlsStayOnTheLoopbackPort() {
		assertEquals("http://127.0.0.1:3000/", Server.base(3000))
		assertTrue(Server.isInternal("http://127.0.0.1:3000/chat/abc", 3000))
		assertTrue(Server.isInternal("http://127.0.0.1:3000", 3000))
		assertFalse(Server.isInternal("http://127.0.0.1:3001/", 3000))
		assertFalse(Server.isInternal("http://localhost:3000/", 3000))
		assertFalse(Server.isInternal("https://example.com/", 3000))
		assertFalse(Server.isInternal("http://127.0.0.1:30000/", 3000))
	}

	@Test fun healthNeedsOkTrue() {
		assertTrue(Server.isHealthy("{\"ok\":true,\"version\":\"0.3.6\",\"tokenMode\":true}"))
		assertTrue(Server.isHealthy("{ \"ok\" : true }"))
		assertFalse(Server.isHealthy("{\"ok\":false}"))
		assertFalse(Server.isHealthy("<html>Not paired</html>"))
	}

	@Test fun cookieMatchesTheServersPairingCookie() {
		val c = Server.cookie(token)
		assertTrue(c.startsWith("lh_token=$token;"))
		assertTrue(c.contains("HttpOnly") && c.contains("SameSite=Strict") && c.contains("Path=/"))
	}

	@Test fun flowDecisions() {
		assertEquals(Next.Load, Flow.decide(dev = true, healthy = false, installed = false, updateAvailable = false, loggedIn = false))
		assertEquals(Next.Load, Flow.decide(dev = false, healthy = true, installed = false, updateAvailable = true, loggedIn = false))
		assertEquals(Next.Provision, Flow.decide(dev = false, healthy = false, installed = false, updateAvailable = false, loggedIn = true))
		// an installed app with a newer release asks first, before the sign-in check or a start
		assertEquals(Next.Update, Flow.decide(dev = false, healthy = false, installed = true, updateAvailable = true, loggedIn = true))
		assertEquals(Next.Update, Flow.decide(dev = false, healthy = false, installed = true, updateAvailable = true, loggedIn = false))
		assertEquals(Next.Login, Flow.decide(dev = false, healthy = false, installed = true, updateAvailable = false, loggedIn = false))
		assertEquals(Next.Start, Flow.decide(dev = false, healthy = false, installed = true, updateAvailable = false, loggedIn = true))
	}

	@Test fun tokensAreFortyEightHexCharactersFromTwentyFourBytes() {
		val t = Token.fromBytes(ByteArray(24) { it.toByte() })
		assertEquals(48, t.length)
		assertEquals("000102", t.take(6))
		assertEquals(t, Token.parse(t + "\n"))
	}

	@Test fun releaseAssetsAndChecksums() {
		assertEquals("https://h/r/a.tar.gz", Release.url("https://h/r/", "a.tar.gz"))
		val sha = "ab".repeat(32)
		assertEquals(sha, Release.parseSha256("$sha  learnharness-server-linux-arm64.tar.zst\n"))
		assertEquals(sha, Release.parseSha256(sha.uppercase()))
		assertNull(Release.parseSha256("<html>404</html>"))
		assertNull(Release.parseSha256("abc  file"))
		assertNull(Release.parseSha256(null))
	}

	@Test fun versionsAreOneLineAndUnknownNeverForcesAnUpdate() {
		assertEquals("0.3.6+60d9e57", Release.parseVersion("0.3.6+60d9e57\n"))
		assertNull(Release.parseVersion("\n  \n"))
		assertNull(Release.parseVersion("x".repeat(200)))
		assertTrue(Release.outdated(installed = null, remote = "1"))
		assertTrue(Release.outdated(installed = "1", remote = "2"))
		assertFalse(Release.outdated(installed = "2", remote = "2"))
		assertFalse(Release.outdated(installed = "1", remote = null))
	}

	@Test fun loginLinkIsReadFromTheTerminalOutput() {
		val link = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y"
		// what `script` shows: a hyperlink escape (OSC 8) around the link, then the link again, then the prompt
		val shown = "Opening browser to sign in…\r\nIf the browser didn't open, visit: \u001B]8;;$link\u0007$link\u001B]8;;\u0007\r\nPaste code here if prompted > "
		assertEquals(link, LoginOutput.url(shown))
		assertNull(LoginOutput.url("Opening browser…"))
		assertTrue(LoginOutput.succeeded("Paste code here if prompted > \u001B[32mLogin successful.\u001B[0m\r\n"))
		assertFalse(LoginOutput.succeeded("Paste code here if prompted > "))
	}

	@Test fun loginStatusIsReadFromTheJson() {
		assertTrue(LoginOutput.loggedIn("{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\"\n}"))
		assertFalse(LoginOutput.loggedIn("{\"loggedIn\": false}"))
		assertFalse(LoginOutput.loggedIn("claude: command not found"))
	}

	@Test fun serverEnvironmentCarriesThePortAndTheToken() {
		val env = ServerEnv.of(3001, token)
		assertEquals("3001", env["PORT"])
		assertEquals(token, env["LH_ACCESS_TOKEN"])
		assertEquals("127.0.0.1", env["HOSTNAME"])
		assertEquals("/root/lh-data", env["LH_DATA_DIR"])
		assertFalse(env.containsKey("CHROME_PATH"))
	}

	@Test fun firstRunSeedsTheThreeClaudeSlots() {
		val json = org.json.JSONObject(FirstRun.MODELS_SETTINGS).getJSONObject("models")
		for (slot in listOf("strong", "cheap", "vision")) {
			assertEquals("claude-code", json.getJSONObject(slot).getJSONObject("model").getString("provider"))
		}
		assertEquals("claude-opus-5-5", json.getJSONObject("strong").getJSONObject("model").getString("id"))
		assertEquals("claude-haiku-5-5", json.getJSONObject("cheap").getJSONObject("model").getString("id"))
		assertEquals("claude-sonnet-5-5", json.getJSONObject("vision").getJSONObject("model").getString("id"))
	}

	@Test fun theGuestGetsThePhonesResolversOrPublicOnesWhenThereAreNone() {
		assertEquals("nameserver 192.168.0.1\nnameserver 2001:db8::1\n", ResolvConf.render(listOf("192.168.0.1", "2001:db8::1")))
		// an IPv6 link-local resolver carries an interface scope the guest cannot use; duplicates collapse
		assertEquals("nameserver fe80::1\n", ResolvConf.render(listOf("fe80::1%wlan0", "fe80::1")))
		assertEquals("nameserver 1.1.1.1\nnameserver 8.8.8.8\n", ResolvConf.render(emptyList()))
		assertEquals("nameserver 1.1.1.1\nnameserver 8.8.8.8\n", ResolvConf.render(listOf("not an address")))
	}

	@Test fun claudeIsPinnedToOneExactVersion() {
		assertTrue(Regex("[0-9]+\\.[0-9]+\\.[0-9]+").matches(Release.CLAUDE_VERSION))
	}

	@Test fun guestPathFindsTheHomeInstalledClaudeFirst() {
		assertTrue(ProotCommand.GUEST_ENV.getValue("PATH").startsWith("/root/.local/bin:"))
	}

	@Test fun prootCommandLine() {
		val args = ProotCommand.args(
			proot = "/lib/libproot.so", rootfs = "/files/rootfs",
			binds = listOf("/dev" to "/dev", "/files/home" to "/root"),
			workdir = "/root", env = mapOf("A" to "1"), argv = listOf("node", "server.js"),
		)
		assertEquals(
			listOf(
				"/lib/libproot.so", "--kill-on-exit", "--link2symlink", "-r", "/files/rootfs",
				"-b", "/dev:/dev", "-b", "/files/home:/root", "-w", "/root",
				"/usr/bin/env", "-i", "A=1", "node", "server.js",
			),
			args,
		)
	}

	@Test fun backOrder() {
		assertEquals(BackAction.NONE, Back.action(webHandled = true, canGoBack = true))
		assertEquals(BackAction.GO_BACK, Back.action(webHandled = false, canGoBack = true))
		assertEquals(BackAction.EXIT, Back.action(webHandled = false, canGoBack = false))
	}

	@Test fun backScriptDispatchesTheEventAndReturnsTheFlag() {
		assertTrue(Back.SCRIPT.contains("'lh:back'"))
		assertTrue(Back.SCRIPT.contains("return d.handled"))
	}

	@Test fun redactionHidesTokensAndLinks() {
		val shown = Redact.tokens("open http://127.0.0.1:3000/?lh_token=$token now, raw $token")
		assertFalse(shown.contains(token))
		assertTrue(shown.contains("open http://127.0.0.1:3000/?lh_token=… now"))
		assertEquals("plain text", Redact.tokens("plain text"))
	}

	@Test fun insetsBecomeCssPixels() {
		val s = Insets.script(topPx = 120, rightPx = 0, bottomPx = 63, leftPx = 0, density = 2.625f)
		assertTrue(s.contains("'--lh-safe-top','46px'"))
		assertTrue(s.contains("'--lh-safe-bottom','24px'"))
		assertTrue(s.contains("'--lh-safe-left','0px'"))
	}
}
