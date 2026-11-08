package dev.learnharness.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

class InkAngleTest {
	private fun rad(d: Double) = d * PI / 180.0

	/** A stored line as linePoints writes it. */
	private fun line(ax: Float, ay: Float, bx: Float, by: Float) = InkStraight.linePoints(ax, ay, bx, by)

	private fun seg(ax: Float, ay: Float, bx: Float, by: Float) = InkAngle.segment(line(ax, ay, bx, by))!!

	private fun guide(sx: Double, sy: Double, angle: Double, len: Double, segs: List<InkAngle.Segment>, zoom: Double = 1.0) =
		InkAngle.guide(sx, sy, sx + cos(rad(angle)) * len, sy + sin(rad(angle)) * len, segs, zoom)

	private val horizontal = listOf(seg(0f, 0f, 100f, 0f))

	@Test fun aLineAsLinePointsWritesItIsRecognisedAtAnyAngle() {
		val s = InkAngle.segment(line(10f, 20f, 110f, 20f))!!
		assertEquals(10.0, s.ax, 1e-4)
		assertEquals(110.0, s.bx, 1e-4)
		assertNotNull(InkAngle.segment(line(0f, 0f, 70f, 40f)))
	}

	@Test fun aWobblyStrokeAUnevenStrokeADotAndAShortLineAreNotLines() {
		assertNull(InkAngle.segment(floatArrayOf(0f, 0f, 0.5f, 40f, 3f, 0.5f, 80f, 0f, 0.5f, 120f, 4f, 0.5f)))
		assertNull(InkAngle.segment(floatArrayOf(0f, 0f, 0.5f, 5f, 0f, 0.5f, 60f, 0f, 0.5f, 100f, 0f, 0.5f)))
		assertNull(InkAngle.segment(floatArrayOf(3f, 3f, 0.5f, 3f, 3f, 0.5f)))
		assertNull(InkAngle.segment(floatArrayOf(1f, 2f, 0.5f)))
		assertNull(InkAngle.segment(floatArrayOf(0f, 0f, 0.5f, 4f, 0f, 0.5f)))
		assertNotNull(InkAngle.segment(floatArrayOf(0f, 0f, 0.5f, 6f, 0f, 0.5f)))
	}

	@Test fun segmentsKeepsTheStraightOnes() {
		val list = listOf(line(0f, 0f, 50f, 0f), floatArrayOf(0f, 0f, 0.5f, 40f, 9f, 0.5f, 90f, 1f, 0.5f), line(0f, 5f, 0f, 65f))
		assertEquals(2, InkAngle.segments(list).size)
	}

	@Test fun theAngleIsMeasuredAtTheClosestPointOfTheOtherLine() {
		val g = guide(50.0, 6.0, 60.0, 80.0, horizontal)!!
		assertEquals(60, g.degrees)
		assertEquals(50.0, g.vx, 1e-4)
		assertEquals(0.0, g.vy, 1e-4)
		assertEquals(60.0, g.from, 1e-6)
		assertEquals(-60.0, g.sweep, 1e-6)
	}

	@Test fun theSmallerAngleIsShownWhicheverWayTheNewLineLeans() {
		val g = guide(50.0, 6.0, 120.0, 80.0, horizontal)!!
		assertEquals(60, g.degrees)
		assertEquals(120.0, g.from, 1e-6)
		assertEquals(60.0, g.sweep, 1e-6)
		val right = guide(50.0, 6.0, 90.0, 80.0, horizontal)!!
		assertEquals(90, right.degrees)
		assertTrue(Math.abs(right.sweep) <= 90.0 + 1e-6)
	}

	@Test fun aStartBeyondTheEndOfTheOtherLineMeetsItsEnd() {
		val g = guide(-5.0, 3.0, 45.0, 60.0, horizontal)!!
		assertEquals(0.0, g.vx, 1e-4)
		assertEquals(0.0, g.vy, 1e-4)
		assertEquals(45, g.degrees)
	}

	@Test fun linesParallelToWithinADegreeShowNothing() {
		assertNull(guide(50.0, 6.0, 0.5, 80.0, horizontal))
		assertNull(guide(50.0, 6.0, 180.0, 80.0, horizontal))
		assertNotNull(guide(50.0, 6.0, 2.0, 80.0, horizontal))
	}

	@Test fun theStartMustBeWithinNearPxOnScreenWhateverTheZoom() {
		assertNull(guide(50.0, 20.0, 60.0, 80.0, horizontal, 1.0))
		assertNotNull(guide(50.0, 20.0, 60.0, 80.0, horizontal, 0.5))
		assertNull(guide(50.0, 20.0, 60.0, 80.0, horizontal, 2.0))
		assertNotNull(guide(50.0, InkAngle.NEAR_PX, 60.0, 80.0, horizontal, 1.0))
	}

	@Test fun theNearestLineWins() {
		val lines = listOf(seg(0f, -8f, 100f, -8f), seg(50f, 0f, 100f, 40f), seg(50f, -10f, 50f, -60f))
		val g = guide(50.0, 0.0, 90.0, 80.0, lines)!!
		assertEquals(Math.round(90.0 - Math.toDegrees(Math.atan2(40.0, 50.0))).toInt(), g.degrees)
	}

	@Test fun theArcRadiusIsAShareOfTheNewLineBetweenTheBoundsAndInsideTheOtherLine() {
		fun r(len: Double, segs: List<InkAngle.Segment> = horizontal, zoom: Double = 1.0) = guide(50.0, 6.0, 60.0, len, segs, zoom)!!.radiusPx
		assertEquals(50.0, r(200.0), 1e-6)
		assertEquals(InkAngle.ARC_MIN_PX, r(10.0), 1e-6)
		assertEquals(InkAngle.ARC_MAX_PX, r(2000.0), 1e-6)
		assertEquals(80.0, r(200.0, horizontal, 2.0), 1e-6)
		assertEquals(20.0, r(2000.0, listOf(seg(40f, 0f, 60f, 0f))), 1e-4)
	}

	@Test fun aLineOfNoLengthOrAZoomThatCannotBeShowsNothing() {
		assertNull(InkAngle.guide(50.0, 6.0, 50.0, 6.0, horizontal, 1.0))
		assertNull(guide(50.0, 6.0, 60.0, 80.0, horizontal, 0.0))
		assertNull(guide(50.0, 6.0, 60.0, 80.0, emptyList()))
	}
}
