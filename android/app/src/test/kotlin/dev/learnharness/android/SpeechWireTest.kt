package dev.learnharness.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Kotlin half of src/core/speech-bridge.ts; tests/speech-bridge.test.ts pins the page's half. */
class SpeechWireTest {
	@Test fun pageOperationsParse() {
		assertEquals(SpeechOp.Probe, SpeechWire.parse("speech probe"))
		assertEquals(SpeechOp.Start("nb"), SpeechWire.parse("speech start nb"))
		assertEquals(SpeechOp.Start("en"), SpeechWire.parse("  speech   start   en \n"))
		assertEquals(SpeechOp.Stop, SpeechWire.parse("speech stop"))
		assertEquals(SpeechOp.Cancel, SpeechWire.parse("speech cancel"))
	}

	@Test fun otherLinesAreNotSpeech() {
		assertNull(SpeechWire.parse("open key 1 2 3 4"))
		assertNull(SpeechWire.parse("speech"))
		assertNull(SpeechWire.parse("speech start"))
		assertNull(SpeechWire.parse("speech dance"))
		assertTrue(SpeechWire.isSpeech("speech stop"))
		assertFalse(SpeechWire.isSpeech("strokes []"))
		assertFalse(SpeechWire.isSpeech("speechless"))
	}

	@Test fun lessonLanguagesMapToLocales() {
		assertEquals("en-US", SpeechWire.locale("en"))
		assertEquals("nb-NO", SpeechWire.locale("nb"))
		assertNull(SpeechWire.locale("sv"))
	}

	@Test fun linesToThePageAreOneLineEach() {
		assertEquals("speech ready", SpeechWire.ready())
		assertEquals("speech state listening", SpeechWire.state("listening"))
		assertEquals("speech partial hello the", SpeechWire.partial("hello\n  the "))
		assertEquals("speech level 0.00", SpeechWire.level(-2f))
		assertEquals("speech level 0.50", SpeechWire.level(4f))
		assertEquals("speech level 1.00", SpeechWire.level(30f))
		assertEquals("speech final first line second line", SpeechWire.final("first line\n  second\tline "))
		assertEquals("speech error busy", SpeechWire.error("busy"))
		assertEquals("speech error language nb", SpeechWire.error("language", "nb"))
		assertEquals("speech error other code 3", SpeechWire.error("other", "code\n3"))
	}
}
