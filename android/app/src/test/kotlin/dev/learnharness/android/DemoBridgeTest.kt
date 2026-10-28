package dev.learnharness.android

import java.io.ByteArrayInputStream
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DemoBridgeTest {
	private fun request(head: String, body: String = ""): LoopbackHttp.Request =
		LoopbackHttp.read(ByteArrayInputStream((head.replace("\n", "\r\n") + "\r\n\r\n" + body).toByteArray()))

	@Test fun aPostWithAJsonBodyIsParsed() {
		val body = """{"html":"<p>hi</p>","probe":null}"""
		val r = request("POST /run-demo HTTP/1.1\nHost: 127.0.0.1\nX-LH-Token: abc\nContent-Length: ${body.toByteArray().size}", body)
		assertEquals("POST", r.method)
		assertEquals("/run-demo", r.path)
		assertEquals("abc", r.headers["x-lh-token"])
		assertEquals(body, r.body)
	}

	@Test fun multiByteBodiesAreReadByByteLength() {
		val body = """{"html":"æøå ✓"}"""
		val r = request("POST /run-demo HTTP/1.1\nContent-Length: ${body.toByteArray(Charsets.UTF_8).size}", body)
		assertEquals(body, r.body)
	}

	@Test fun aRequestWithoutABodyHasAnEmptyOne() {
		assertEquals("", request("GET /x HTTP/1.1\nHost: h").body)
	}

	@Test fun truncatedOrOversizedRequestsAreRefused() {
		try {
			LoopbackHttp.read(ByteArrayInputStream("POST / HTTP/1.1\r\nContent-Length: 50\r\n\r\nshort".toByteArray()))
			fail("a truncated body must throw")
		} catch (_: IOException) {
		}
		try {
			request("POST / HTTP/1.1\nContent-Length: 999999999")
			fail("an oversized body must throw")
		} catch (_: IOException) {
		}
		try {
			LoopbackHttp.read(ByteArrayInputStream("POST / HTTP/1.1\r\nHost: x".toByteArray()))
			fail("headers that never end must throw")
		} catch (_: IOException) {
		}
	}

	@Test fun responsesCarryTheirLengthInBytes() {
		val text = String(LoopbackHttp.response(200, """{"a":"é"}"""), Charsets.UTF_8)
		assertTrue(text.startsWith("HTTP/1.1 200 OK\r\n"))
		assertTrue(text.contains("Content-Length: 10\r\n"))
		assertTrue(text.endsWith("""{"a":"é"}"""))
		assertTrue(String(LoopbackHttp.response(403, "{}")).startsWith("HTTP/1.1 403 Forbidden"))
	}

	@Test fun theTokenComparisonNeverAcceptsAMissingOrWrongToken() {
		assertTrue(LoopbackHttp.tokenMatches("abc", "abc"))
		assertFalse(LoopbackHttp.tokenMatches(null, "abc"))
		assertFalse(LoopbackHttp.tokenMatches("abd", "abc"))
		assertFalse(LoopbackHttp.tokenMatches("", "abc"))
	}

	@Test fun probeResultsComeBackUnquoted() {
		assertNull(DemoPage.unquote(null))
		assertNull(DemoPage.unquote("null"))
		assertEquals("""{"v":3}""", DemoPage.unquote(""""{\"v\":3}""""))
	}

	@Test fun theProbeIsEvaluatedWithIndirectEvalAndItsValueParked() {
		val js = DemoPage.probeStart("(async () => 1)()")
		assertTrue(js.contains("(0, eval)(\"(async () => 1)()\")"))
		assertTrue(js.contains("__lhProbeDone"))
	}

	@Test fun theServerLearnsTheBridgeOnlyWhenThereIsOne() {
		val without = ServerEnv.of(3000, "t")
		assertFalse(without.containsKey("LH_DEMO_BRIDGE_URL"))
		val with = ServerEnv.of(3000, "t", bridgePort = 41234, bridgeToken = "b")
		assertEquals("http://127.0.0.1:41234", with["LH_DEMO_BRIDGE_URL"])
		assertEquals("b", with["LH_DEMO_BRIDGE_TOKEN"])
	}
}
