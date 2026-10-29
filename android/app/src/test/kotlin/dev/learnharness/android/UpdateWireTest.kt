package dev.learnharness.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateWireTest {
	@Test fun pageLinesBecomeOps() {
		assertEquals(UpdateOp.Probe, UpdateWire.parse("update probe"))
		assertEquals(UpdateOp.Start, UpdateWire.parse(" update start\n"))
		assertEquals(UpdateOp.Later, UpdateWire.parse("update later"))
	}

	@Test fun unknownUpdateVerbsAreIgnored() {
		assertNull(UpdateWire.parse("update"))
		assertNull(UpdateWire.parse("update now"))
		assertNull(UpdateWire.parse("update start please"))
		assertNull(UpdateWire.parse("open 1 2 3 4"))
	}

	@Test fun routingIsByThePrefixOnly() {
		assertTrue(UpdateWire.isUpdate("update probe"))
		assertTrue(UpdateWire.isUpdate("  update whatever"))
		assertFalse(UpdateWire.isUpdate("speech probe"))
		assertFalse(UpdateWire.isUpdate("updated"))
	}

	@Test fun theShellAnswerIsOneFixedLine() {
		assertEquals("update available", UpdateWire.AVAILABLE)
	}
}
