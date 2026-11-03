package dev.learnharness.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IdlePolicyTest {
	private val minute = 60_000L

	@Test fun limitsAreTenAndFortyFiveMinutes() {
		assertEquals(10 * minute, IdlePolicy.RELEASE_WAKE_LOCK_MS)
		assertEquals(45 * minute, IdlePolicy.STOP_SERVER_MS)
	}

	@Test fun nothingHappensBeforeTenMinutes() {
		assertEquals(IdlePolicy.Step.KEEP, IdlePolicy.step(0))
		assertEquals(IdlePolicy.Step.KEEP, IdlePolicy.step(10 * minute - 1))
	}

	@Test fun theWakeLockGoesAtTenMinutesAndTheServerStaysLoaded() {
		assertEquals(IdlePolicy.Step.RELEASE_WAKE_LOCK, IdlePolicy.step(10 * minute))
		assertEquals(IdlePolicy.Step.RELEASE_WAKE_LOCK, IdlePolicy.step(45 * minute - 1))
	}

	@Test fun theServerStopsAtFortyFiveMinutes() {
		assertEquals(IdlePolicy.Step.STOP, IdlePolicy.step(45 * minute))
		assertEquals(IdlePolicy.Step.STOP, IdlePolicy.step(24 * 60 * minute))
	}

	@Test fun theWakeLockIsHeldUntilTheFirstLimit() {
		assertTrue(IdlePolicy.holdWakeLock(0))
		assertTrue(IdlePolicy.holdWakeLock(10 * minute - 1))
		assertFalse(IdlePolicy.holdWakeLock(10 * minute))
		assertFalse(IdlePolicy.holdWakeLock(60 * minute))
	}

	@Test fun pollingIsFinerThanTheShortestLimit() {
		assertTrue(IdlePolicy.POLL_MS * 4 < IdlePolicy.RELEASE_WAKE_LOCK_MS)
	}

	@Test fun busyIsReadFromTheServersAnswer() {
		assertEquals(true, ServerBusy.parse("""{"busy":true,"reasons":["a turn is running"]}"""))
		assertEquals(false, ServerBusy.parse("""{"busy":false,"reasons":[]}"""))
		assertEquals(false, ServerBusy.parse("""{ "busy" : false }"""))
	}

	@Test fun anAnswerNobodyUnderstoodIsNotAReport() {
		assertNull(ServerBusy.parse(""))
		assertNull(ServerBusy.parse("<html>502 Bad Gateway</html>"))
		assertNull(ServerBusy.parse("""{"ok":true,"version":"0.4.1"}"""))
	}

	@Test fun theRequestCarriesTheTokenCookieAndStaysOnTheLoopback() {
		assertEquals("http://127.0.0.1:3000/api/busy", ServerBusy.url(3000))
		assertEquals("lh_token=abc", ServerBusy.cookieHeader("abc"))
	}
}

class IdleLimitsTest {
	@Test fun withNoFileTheRealLimitsApply() {
		assertEquals(IdlePolicy.Limits.DEFAULT, IdlePolicy.limitsFrom(null))
		assertEquals(IdlePolicy.Limits.DEFAULT, IdlePolicy.limitsFrom(""))
	}

	@Test fun aDeviceCheckCanShortenThemInSeconds() {
		val l = IdlePolicy.limitsFrom("20 50 5\n")
		assertEquals(IdlePolicy.Limits(20_000, 50_000, 5_000), l)
		assertEquals(IdlePolicy.Step.KEEP, IdlePolicy.step(19_999, l))
		assertEquals(IdlePolicy.Step.RELEASE_WAKE_LOCK, IdlePolicy.step(20_000, l))
		assertEquals(IdlePolicy.Step.STOP, IdlePolicy.step(50_000, l))
		assertFalse(IdlePolicy.holdWakeLock(20_000, l))
	}

	@Test fun anythingOddFallsBackToTheRealLimits() {
		for (bad in listOf("20", "20 50", "20 50 5 9", "a b c", "0 50 5", "-1 50 5", "50 20 5", "20 20 5", "20 50 0")) {
			assertEquals(bad, IdlePolicy.Limits.DEFAULT, IdlePolicy.limitsFrom(bad))
		}
	}
}

class ProcessTreeTest {
	@Test fun theParentIsReadAfterTheLastParenthesis() {
		assertEquals(1077, ProcessTree.parentOf("23599 (next-server (v) S 1077 1077 0 0 -1 4194304"))
		assertEquals(23597, ProcessTree.parentOf("23599 (node) S 23597 23597 0 0"))
		assertEquals(5, ProcessTree.parentOf("7 (a b) c) R 5 5 0"))
	}

	@Test fun garbageHasNoParent() {
		assertNull(ProcessTree.parentOf(""))
		assertNull(ProcessTree.parentOf("no parentheses here"))
		assertNull(ProcessTree.parentOf("1 (x) S"))
		assertNull(ProcessTree.parentOf("1 (x) S notanumber"))
	}

	@Test fun descendantsAreEverythingBelowTheRootAndNeverTheRoot() {
		// 10 (proot) -> 11 (env) -> 12 (node) -> 13, 14 ; 20 is unrelated ; 30 is a child of 20
		val parent = mapOf(11 to 10, 12 to 11, 13 to 12, 14 to 12, 20 to 1, 30 to 20)
		assertEquals(listOf(11, 12, 13, 14), ProcessTree.descendants(10, parent))
		assertEquals(listOf(13, 14), ProcessTree.descendants(12, parent))
		assertEquals(emptyList<Int>(), ProcessTree.descendants(14, parent))
		assertEquals(emptyList<Int>(), ProcessTree.descendants(99, parent))
	}

	@Test fun aLoopInTheTableCannotHangIt() {
		assertEquals(listOf(2), ProcessTree.descendants(1, mapOf(2 to 1, 1 to 2)))
	}
}
