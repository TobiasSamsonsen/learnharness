package dev.learnharness.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class InkSheetTest {
	private fun rgb(argb: Int) = argb and 0xFFFFFF

	@Test fun aLightSheetShowsInkAsDrawn() {
		assertEquals(0x111111, rgb(InkSheet.displayColor(null, dark = false)))
		assertEquals(0xDC2626, rgb(InkSheet.displayColor("#DC2626", dark = false)))
	}

	@Test fun aDarkSheetShowsThePaletteInLighterTones_theSameTableAsTheWeb() {
		assertEquals("default ink", 0xF5F5F4, rgb(InkSheet.displayColor(null, dark = true)))
		assertEquals(0xF5F5F4, rgb(InkSheet.displayColor("#111111", dark = true)))
		assertEquals(0xF87171, rgb(InkSheet.displayColor("#dc2626", dark = true)))
		assertEquals(0x4ADE80, rgb(InkSheet.displayColor("#16a34a", dark = true)))
		assertEquals(0xFB923C, rgb(InkSheet.displayColor("#ea580c", dark = true)))
		assertEquals(0x60A5FA, rgb(InkSheet.displayColor("#2563EB", dark = true)))
	}

	@Test fun aColourTheTableDoesNotKnowIsLightenedWhenDarkAndLeftAloneWhenLight() {
		// 0x203040 is dark: blended 55% toward white
		val shown = rgb(InkSheet.displayColor("#203040", dark = true))
		assertNotEquals(0x203040, shown)
		assertEquals(0x9BA2A9, shown)
		// a light colour stays
		assertEquals(0xFFE680, rgb(InkSheet.displayColor("#ffe680", dark = true)))
		assertEquals(0x203040, rgb(InkSheet.displayColor("#203040", dark = false)))
	}

	@Test fun thePapers() {
		assertEquals(0xFF1C1917.toInt(), InkSheet.DARK_PAPER)
		assertEquals(0xFFFFFFFF.toInt(), InkSheet.LIGHT_PAPER)
	}
}
