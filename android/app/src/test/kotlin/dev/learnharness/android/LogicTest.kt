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
		assertEquals(Next.Load, Flow.decide(dev = true, healthy = false, termuxInstalled = false, runCommandGranted = false))
		assertEquals(Next.Load, Flow.decide(dev = false, healthy = true, termuxInstalled = false, runCommandGranted = false))
		assertEquals(Next.NeedTermux, Flow.decide(dev = false, healthy = false, termuxInstalled = false, runCommandGranted = true))
		assertEquals(Next.NeedRunCommandPermission, Flow.decide(dev = false, healthy = false, termuxInstalled = true, runCommandGranted = false))
		assertEquals(Next.Start, Flow.decide(dev = false, healthy = false, termuxInstalled = true, runCommandGranted = true))
	}

	@Test fun termuxProblems() {
		assertEquals(TermuxProblem.NONE, TermuxResult.problem(0, -1, null, ""))
		assertEquals(
			TermuxProblem.ALLOW_EXTERNAL_APPS,
			TermuxResult.problem(null, 1, "RUN_COMMAND requires allow-external-apps=true in termux.properties", null),
		)
		assertEquals(TermuxProblem.LH_MISSING, TermuxResult.problem(127, -1, null, "bash: lh: command not found"))
		assertEquals(TermuxProblem.LH_MISSING, TermuxResult.problem(1, -1, null, "No such file or directory"))
		assertEquals(TermuxProblem.OTHER, TermuxResult.problem(1, -1, null, "lh: something else"))
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
