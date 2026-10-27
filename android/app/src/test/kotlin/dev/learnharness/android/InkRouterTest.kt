package dev.learnharness.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InkRouterTest {
	private val surface = InkRect(0f, 100f, 400f, 600f)
	private val box = InkRect(10f, 110f, 300f, 200f)
	private val finger = 1
	private val stylus = InkRouter.TOOL_TYPE_STYLUS
	private val eraserEnd = InkRouter.TOOL_TYPE_ERASER

	private fun p(id: Int, x: Float, y: Float, tool: Int) = InkPointer(id, x, y, tool)
	private fun InkRouter.down(x: Float, y: Float, tool: Int) = step(InkAction.DOWN, listOf(p(0, x, y, tool)), 0, surface, listOf(box))

	@Test fun aStylusDrawsOnTheCanvasButNotThroughTheFloatingBox() {
		val r = InkRouter()
		assertEquals(InkRoute.INK, r.down(50f, 500f, stylus).route)
		r.step(InkAction.UP, listOf(p(0, 50f, 500f, stylus)), 0, surface, listOf(box))
		assertEquals("on the box", InkRoute.WEB, r.down(50f, 150f, stylus).route)
		r.step(InkAction.UP, listOf(p(0, 50f, 150f, stylus)), 0, surface, listOf(box))
		assertEquals("above the canvas", InkRoute.WEB, r.down(50f, 50f, stylus).route)
	}

	@Test fun theEraserEndDrawsLikeAStylus() {
		assertEquals(InkRoute.INK, InkRouter().down(50f, 500f, eraserEnd).route)
	}

	@Test fun noStylusSeenYet_oneFingerDraws_thisIsTheOwnersPhone() {
		val r = InkRouter()
		assertFalse(r.penSeen)
		assertEquals(InkRoute.INK, r.down(50f, 500f, finger).route)
		assertEquals(InkRoute.INK, r.step(InkAction.MOVE, listOf(p(0, 60f, 510f, finger)), 0, surface, listOf(box)).route)
		assertEquals(InkRoute.INK, r.step(InkAction.UP, listOf(p(0, 60f, 510f, finger)), 0, surface, listOf(box)).route)
		assertFalse("a finger never counts as a stylus", r.penSeen)
	}

	@Test fun aFingerOnTheBoxOrOutsideTheCanvasStaysWithThePage() {
		assertEquals(InkRoute.WEB, InkRouter().down(50f, 150f, finger).route)
		assertEquals(InkRoute.WEB, InkRouter().down(50f, 50f, finger).route)
		assertEquals("no canvas open", InkRoute.WEB, InkRouter().step(InkAction.DOWN, listOf(p(0, 50f, 500f, finger)), 0, null, emptyList()).route)
	}

	@Test fun aSecondFingerDropsTheStrokeAndScrollsThePage() {
		val r = InkRouter()
		r.down(50f, 500f, finger)
		val two = listOf(p(0, 50f, 500f, finger), p(1, 200f, 520f, finger))
		val first = r.step(InkAction.POINTER_DOWN, two, 1, surface, listOf(box))
		assertEquals(InkRoute.PAN, first.route)
		assertTrue("the stroke the first finger began is dropped", first.cancelInk)
		// both fingers move 30 px down: the mean moves 30
		val moved = listOf(p(0, 50f, 530f, finger), p(1, 200f, 550f, finger))
		val move = r.step(InkAction.MOVE, moved, 0, surface, listOf(box))
		assertEquals(InkRoute.PAN, move.route)
		assertEquals(30f, move.panDy, 0.001f)
		// lifting one finger does not jump the page; the other keeps scrolling
		r.step(InkAction.POINTER_UP, moved, 1, surface, listOf(box))
		val one = r.step(InkAction.MOVE, listOf(p(0, 50f, 540f, finger)), 0, surface, listOf(box))
		assertEquals(10f, one.panDy, 0.001f)
		assertEquals("a finished pan is swallowed", InkRoute.NONE, r.step(InkAction.UP, listOf(p(0, 50f, 540f, finger)), 0, surface, listOf(box)).route)
		assertEquals("the next gesture starts clean", InkRoute.INK, r.down(50f, 500f, finger).route)
	}

	@Test fun onceARealStylusHasBeenSeen_touchStopsDrawingAndScrolls() {
		val r = InkRouter()
		val seen = r.down(50f, 500f, stylus)
		assertTrue("tells the page, once", seen.penSeenNow)
		r.step(InkAction.UP, listOf(p(0, 50f, 500f, stylus)), 0, surface, listOf(box))
		assertTrue(r.penSeen)
		assertEquals(InkRoute.WEB, r.down(50f, 500f, finger).route)
		r.step(InkAction.UP, listOf(p(0, 50f, 500f, finger)), 0, surface, listOf(box))
		assertFalse("not announced again", r.down(60f, 500f, stylus).penSeenNow)
	}

	@Test fun aPalmBesideTheStylusIsIgnored() {
		val r = InkRouter()
		r.down(50f, 500f, stylus)
		val palm = r.step(InkAction.POINTER_DOWN, listOf(p(0, 50f, 500f, stylus), p(1, 300f, 600f, finger)), 1, surface, listOf(box))
		assertEquals(InkRoute.INK, palm.route)
		assertFalse("the stylus stroke goes on", palm.cancelInk)
	}

	@Test fun aGestureThatStartedOnThePageStaysThere() {
		val r = InkRouter()
		assertEquals(InkRoute.WEB, r.down(50f, 150f, finger).route) // on the box
		// it drags out of the box over the canvas: still the page's
		assertEquals(InkRoute.WEB, r.step(InkAction.MOVE, listOf(p(0, 50f, 500f, finger)), 0, surface, listOf(box)).route)
		assertEquals(InkRoute.WEB, r.step(InkAction.UP, listOf(p(0, 50f, 500f, finger)), 0, surface, listOf(box)).route)
	}

	@Test fun anEmptyEventIsIgnored() {
		assertEquals(InkRoute.NONE, InkRouter().step(InkAction.MOVE, emptyList(), 0, surface, emptyList()).route)
	}
}
