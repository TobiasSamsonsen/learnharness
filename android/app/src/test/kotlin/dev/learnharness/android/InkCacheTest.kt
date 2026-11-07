package dev.learnharness.android

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InkCacheTest {
	private fun stroke(size: Float = 4f, color: String? = null, sent: Boolean = false, vararg points: Float) = InkWire.Stroke(size, color, points, sent)

	@Test fun twoStrokesWithTheSameNumbersShareAKey_aNewObjectEachPushIncluded() {
		val a = stroke(4f, "#112233", false, 0f, 0f, 0.5f, 10f, 10f, 0.5f)
		val b = stroke(4f, "#112233", false, 0f, 0f, 0.5f, 10f, 10f, 0.5f)
		assertEquals(StrokeKey(a), StrokeKey(b))
		assertEquals(StrokeKey(a).hashCode(), StrokeKey(b).hashCode())
	}

	@Test fun theKeyChangesWithAnyPointTheSizeOrTheColour() {
		val base = stroke(4f, null, false, 0f, 0f, 0.5f, 10f, 10f, 0.5f)
		assertNotEquals(StrokeKey(base), StrokeKey(stroke(4f, null, false, 0f, 0f, 0.5f, 10f, 10.1f, 0.5f)))
		assertNotEquals(StrokeKey(base), StrokeKey(stroke(5f, null, false, 0f, 0f, 0.5f, 10f, 10f, 0.5f)))
		assertNotEquals(StrokeKey(base), StrokeKey(stroke(4f, "#ff0000", false, 0f, 0f, 0.5f, 10f, 10f, 0.5f)))
		assertNotEquals("a longer stroke is another stroke", StrokeKey(base), StrokeKey(stroke(4f, null, false, 0f, 0f, 0.5f)))
	}

	@Test fun sentIsNotPartOfTheKey_itOnlyDecidesTheDimming() {
		val fresh = stroke(4f, null, false, 1f, 2f, 0.5f)
		val sent = stroke(4f, null, true, 1f, 2f, 0.5f)
		assertEquals(StrokeKey(fresh), StrokeKey(sent))
	}

	@Test fun aStrokeMeetsTheViewWhenItsBoxOrItsWidthReachesIn() {
		val box = floatArrayOf(10f, 10f, 50f, 50f)
		assertTrue(InkCull.visible(box, 4f, 0f, 0f, 100f, 100f))
		// wholly left of the view: out
		assertFalse(InkCull.visible(box, 4f, 60f, 0f, 160f, 100f))
		// its width reaches into the view from the left: in (50 + 4 >= 52)
		assertTrue(InkCull.visible(box, 4f, 52f, 0f, 160f, 100f))
		// above and below
		assertFalse(InkCull.visible(box, 4f, 0f, 70f, 100f, 170f))
		assertFalse(InkCull.visible(box, 4f, 0f, -200f, 100f, -10f))
	}

	@Test fun aStrokeWithNoPointsIsNeverVisible() {
		assertFalse(InkCull.visible(null, 4f, -1e9f, -1e9f, 1e9f, 1e9f))
	}

	@Test fun aRecordingCoversTheStrokeBoxPlusItsWidthInWholePixels() {
		val box = InkCull.nodeBox(floatArrayOf(10.4f, 20.6f, 30.2f, 40.9f), 4f)
		// floor(10.4 - 4), floor(20.6 - 4), ceil(30.2 + 4), ceil(40.9 + 4)
		assertArrayEquals(intArrayOf(6, 16, 35, 45), box)
	}

	@Test fun aRecordingIsNeverEmpty_aDotStillHasAnArea() {
		val box = InkCull.nodeBox(floatArrayOf(5f, 5f, 5f, 5f), 0f)
		assertEquals(5, box[0])
		assertEquals(6, box[2])
		assertEquals(5, box[1])
		assertEquals(6, box[3])
	}

	@Test fun aRecordingIsStaleOnlyOnceTheScaleHasMovedFarEnough() {
		assertFalse(InkCull.scaleStale(3f, 3f))
		assertFalse("a small drift keeps the recording", InkCull.scaleStale(3f, 3.1f))
		assertTrue("a pinch to twice the zoom makes it soft", InkCull.scaleStale(3f, 6f))
		assertTrue("so does zooming out", InkCull.scaleStale(3f, 1.5f))
		assertTrue("never recorded counts as stale", InkCull.scaleStale(0f, 3f))
	}
}
