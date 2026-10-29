package dev.learnharness.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class InkViewTest {
	@Test fun aLayerPointMapsToTheWorldAtAnyZoomAndOrigin() {
		val density = 3f
		// zoom 1, origin 0: device px / density
		assertEquals(10f, InkView().worldX(30f, density), 0.001f)
		// zoom 2 at world (100, -50): a device px of 60 is 60 / (3 * 2) = 10 css px on screen, plus the origin
		val v = InkView(2f, 100f, -50f)
		assertEquals(110f, v.worldX(60f, density), 0.001f)
		assertEquals(-40f, v.worldY(60f, density), 0.001f)
	}

	@Test fun thePenKeepsItsWidthOnScreen_clampedToWhatTheValidatorAccepts() {
		assertEquals(4f, InkView(1f).penWorldSize(4f), 0f)
		assertEquals(2f, InkView(2f).penWorldSize(4f), 0f)
		assertEquals("thin at the top zoom is the floor, not 0.25", 0.5f, InkView(8f).penWorldSize(2f), 0f)
		assertEquals("thick at the bottom zoom is the ceiling, not 80", 64f, InkView(0.1f).penWorldSize(8f), 0f)
	}

	@Test fun theViewLineAcceptsOnlyUsableViews() {
		assertNotNull(InkView.parse(1f, 0f, 0f))
		assertNotNull(InkView.parse(8f, -1e5f, 1e5f))
		assertNull(InkView.parse(0.05f, 0f, 0f))
		assertNull(InkView.parse(8.5f, 0f, 0f))
		assertNull(InkView.parse(Float.NaN, 0f, 0f))
		assertNull(InkView.parse(1f, Float.POSITIVE_INFINITY, 0f))
		assertNull(InkView.parse(null, 0f, 0f))
	}
}
