package dev.learnharness.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The guest command runner's time limit (the "Connecting..." screen used to wait forever on `claude auth status`), and the
 * dictation capture's give-up rule (a failed microphone read used to spin a core).
 */
class ProcessRunTest {
	/** A process that ends at once with [code] and [output], or never ends (until it is destroyed) when [hangs]. */
	private class FakeProcess(output: String, private val code: Int, private val hangs: Boolean) : Process() {
		private val ended = CountDownLatch(if (hangs) 1 else 0)
		@Volatile var destroyed = false
		private val stream: InputStream = if (hangs) {
			object : InputStream() {
				// a pipe a surviving child keeps open: no data, and no end until the process is destroyed
				override fun read(): Int {
					ended.await()
					return -1
				}
			}
		} else ByteArrayInputStream(output.toByteArray())

		override fun getOutputStream(): OutputStream = OutputStream.nullOutputStream()
		override fun getInputStream(): InputStream = stream
		override fun getErrorStream(): InputStream = ByteArrayInputStream(ByteArray(0))
		override fun waitFor(): Int {
			if (hangs) ended.await()
			return code
		}
		override fun waitFor(timeout: Long, unit: TimeUnit): Boolean = if (hangs) ended.await(timeout, unit) else true
		override fun exitValue(): Int = code
		override fun destroy() {
			destroyed = true
			ended.countDown()
		}
	}

	@Test fun aFinishedCommandReturnsItsCodeAndOutput() {
		assertEquals(0 to "signed in\n", ProcessRun.collect(FakeProcess("signed in\n", 0, hangs = false), 5000))
		assertEquals(3 to "boom", ProcessRun.collect(FakeProcess("boom", 3, hangs = false), 0))
	}

	@Test fun aHungCommandIsKilledAfterTheTimeout() {
		val p = FakeProcess("", 0, hangs = true)
		val started = System.currentTimeMillis()
		val (code, _) = ProcessRun.collect(p, 200)
		assertEquals(ProcessRun.TIMED_OUT, code)
		assertTrue("the process was killed", p.destroyed)
		assertTrue("it gave up promptly", System.currentTimeMillis() - started < 3000)
	}

	@Test fun captureFailsAfterARunOfBadReads() {
		assertFalse(LevelMeter.captureFailed(1))
		assertFalse(LevelMeter.captureFailed(LevelMeter.MAX_BAD_READS - 1))
		assertTrue(LevelMeter.captureFailed(LevelMeter.MAX_BAD_READS))
	}
}
