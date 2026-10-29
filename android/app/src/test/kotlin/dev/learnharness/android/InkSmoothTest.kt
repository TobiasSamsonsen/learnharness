package dev.learnharness.android

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.hypot

class InkSmoothTest {
	@Test fun aStrokeOfOneOrTwoPointsIsLeftAlone() {
		val one = floatArrayOf(1f, 2f, 0.5f)
		assertTrue(InkSmooth.densify(one) === one)
		val two = floatArrayOf(0f, 0f, 0.5f, 10f, 0f, 0.5f)
		assertTrue(InkSmooth.densify(two) === two)
	}

	@Test fun everyOriginalSampleIsKeptInOrderAndTheEndsAreUntouched() {
		val p = floatArrayOf(0f, 0f, 0.2f, 6f, 5f, 0.4f, 12f, 4f, 0.6f, 20f, 12f, 0.8f)
		val d = InkSmooth.densify(p)
		assertEquals(0f, d[0], 1e-6f)
		assertEquals(0f, d[1], 1e-6f)
		assertEquals(20f, d[d.size - 3], 1e-6f)
		assertEquals(12f, d[d.size - 2], 1e-6f)
		// each original sample appears (the curve passes through them)
		for (k in 0 until 4) {
			val ox = p[k * 3]
			val oy = p[k * 3 + 1]
			assertTrue("sample $k kept", (0 until d.size / 3).any { i -> kotlin.math.abs(d[i * 3] - ox) < 1e-4f && kotlin.math.abs(d[i * 3 + 1] - oy) < 1e-4f })
		}
	}

	@Test fun thePointsAreAboutOnePixelApartAndThePressureFollowsTheSamples() {
		val p = floatArrayOf(0f, 0f, 0.2f, 6f, 0f, 0.4f, 12f, 0f, 0.6f)
		val d = InkSmooth.densify(p)
		assertTrue("more points than before", d.size > p.size)
		var i = 1
		while (i < d.size / 3) {
			val gap = hypot((d[i * 3] - d[(i - 1) * 3]).toDouble(), (d[i * 3 + 1] - d[(i - 1) * 3 + 1]).toDouble())
			assertTrue("gap $gap", gap <= 1.2)
			assertTrue("pressure never goes backwards on a rising stroke", d[i * 3 + 2] >= d[(i - 1) * 3 + 2] - 1e-6f)
			i++
		}
	}

	@Test fun aStraightRunStaysStraight() {
		val p = floatArrayOf(0f, 0f, 0.5f, 10f, 10f, 0.5f, 20f, 20f, 0.5f, 30f, 30f, 0.5f)
		val d = InkSmooth.densify(p)
		var i = 0
		while (i < d.size / 3) {
			assertEquals(d[i * 3], d[i * 3 + 1], 1e-3f)
			i++
		}
	}

	@Test fun aCornerIsRoundedButStaysNearTheSamples() {
		// a sharp turn: the smoothed curve cuts the corner a little, never wildly
		val p = floatArrayOf(0f, 0f, 0.5f, 20f, 0f, 0.5f, 20f, 20f, 0.5f)
		val d = InkSmooth.densify(p)
		var worst = 0.0
		var i = 0
		while (i < d.size / 3) {
			// distance from the polyline's bounding corner region
			val x = d[i * 3].toDouble()
			val y = d[i * 3 + 1].toDouble()
			worst = maxOf(worst, maxOf(-x, x - 22.0, -y - 2.0, y - 22.0))
			i++
		}
		assertTrue("overshoot $worst", worst < 2.0)
	}

	@Test fun aHugeJumpDoesNotMakeAHugeStroke() {
		val p = floatArrayOf(0f, 0f, 0.5f, 5000f, 0f, 0.5f, 10000f, 0f, 0.5f)
		val d = InkSmooth.densify(p)
		assertTrue("at most ${InkSmooth.MAX_PER_SEGMENT} points per segment", d.size / 3 <= 2 * InkSmooth.MAX_PER_SEGMENT + 1)
		assertArrayEquals(floatArrayOf(10000f, 0f, 0.5f), d.copyOfRange(d.size - 3, d.size), 1e-3f)
	}
}
