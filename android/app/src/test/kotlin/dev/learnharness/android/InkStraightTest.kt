package dev.learnharness.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.hypot

class InkStraightTest {
	@Test fun aLineNearHorizontalVerticalOrDiagonalSnapsAndKeepsItsLength() {
		val (hx, hy) = InkStraight.snapAngle(0f, 0f, 100f, 4f) // about 2.3 degrees
		assertEquals(0f, hy, 1e-3f)
		assertEquals(hypot(100.0, 4.0).toFloat(), hx, 1e-3f)
		val (vx, vy) = InkStraight.snapAngle(0f, 0f, -3f, 80f)
		assertEquals(0f, vx, 1e-3f)
		assertEquals(hypot(3.0, 80.0).toFloat(), vy, 1e-3f)
		val (dx, dy) = InkStraight.snapAngle(0f, 0f, 100f, 104f)
		assertEquals(dx, dy, 1e-3f)
	}

	@Test fun aLineThatIsNotCloseToOneIsLeftAlone() {
		assertEquals(100f to 30f, InkStraight.snapAngle(0f, 0f, 100f, 30f))
		assertEquals(5f to 5f, InkStraight.snapAngle(5f, 5f, 5f, 5f))
	}

	@Test fun aLineIsWrittenWithBothEndsAndEvenSteps() {
		val p = InkStraight.linePoints(0f, 0f, 60f, 0f, 0.7f)
		assertEquals(11 * 3, p.size)
		assertEquals(0f, p[0], 1e-6f)
		assertEquals(0.7f, p[2], 1e-6f)
		assertEquals(60f, p[p.size - 3], 1e-4f)
	}

	@Test fun straightenTurnsAWobblyStrokeIntoALineFromItsStartToItsEnd() {
		val wobbly = floatArrayOf(10f, 10f, 0.4f, 40f, 17f, 0.6f, 70f, 6f, 0.5f, 110f, 12f, 0.5f)
		val line = InkStraight.straighten(wobbly)!!
		assertEquals(10f, line[0], 1e-6f)
		assertEquals(10f, line[1], 1e-6f)
		var i = 1
		while (i < line.size) {
			assertEquals("on the horizontal line", 10f, line[i], 1e-3f)
			i += 3
		}
		assertEquals(10f + hypot(100.0, 2.0).toFloat(), line[line.size - 3], 1e-3f)
		assertEquals("the mean pressure", 0.5f, line[2], 1e-6f)
	}

	@Test fun straightenCanFollowAGivenEnd() {
		val line = InkStraight.straighten(floatArrayOf(0f, 0f, 0.5f, 20f, 3f, 0.5f), 50f, 50f)!!
		assertEquals(50f, line[line.size - 3], 1e-3f)
		assertEquals(50f, line[line.size - 2], 1e-3f)
	}

	@Test fun aStrokeOfOnePointCannotBeStraightened() {
		assertNull(InkStraight.straighten(floatArrayOf(1f, 2f, 0.5f)))
		assertFalse(InkStraight.longEnough(floatArrayOf(1f, 2f, 0.5f), 1f))
	}

	@Test fun onlyAStrokeLongEnoughOnScreenIsALine() {
		val p = floatArrayOf(0f, 0f, 0.5f, 20f, 0f, 0.5f)
		assertFalse("20 px at zoom 1 is a tick", InkStraight.longEnough(p, 1f))
		assertTrue("the same stroke at zoom 2 is 40 px on screen", InkStraight.longEnough(p, 2f))
		assertNotNull(InkStraight.straighten(p))
	}

	@Test fun theHoldNumbersAreTheWebs() {
		assertEquals(500L, InkStraight.HOLD_MS)
		assertEquals(4f, InkStraight.HOLD_RADIUS_DP, 0f)
		assertEquals(24f, InkStraight.MIN_LINE_DP, 0f)
		assertEquals(5.0, InkStraight.SNAP_DEG, 0.0)
	}
}
