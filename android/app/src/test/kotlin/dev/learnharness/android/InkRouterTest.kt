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

	@Test fun twoFingersPinchAndPan_theRouterReportsTheTravelTheScaleAndTheFocus() {
		val r = InkRouter()
		r.down(100f, 500f, finger)
		// the second finger arrives 200 px to the right: midpoint (200, 500), spread 100
		val two = listOf(p(0, 100f, 500f, finger), p(1, 300f, 500f, finger))
		assertEquals(InkRoute.PAN, r.step(InkAction.POINTER_DOWN, two, 1, surface, listOf(box)).route)
		// both move apart by 100 px (spread 100 -> 150) and 20 px down, midpoint stays at x = 200
		val apart = listOf(p(0, 50f, 520f, finger), p(1, 350f, 520f, finger))
		val step = r.step(InkAction.MOVE, apart, 0, surface, listOf(box))
		assertEquals(1.5f, step.scale, 0.001f)
		assertEquals(0f, step.panDx, 0.001f)
		assertEquals(20f, step.panDy, 0.001f)
		assertEquals(200f, step.focusX, 0.001f)
		assertEquals(520f, step.focusY, 0.001f)
		// no movement, no pinch: a step of 1 and no travel
		val still = r.step(InkAction.MOVE, apart, 0, surface, listOf(box))
		assertEquals(1f, still.scale, 0.001f)
		assertEquals(0f, still.panDx, 0.001f)
		// lifting a finger starts the next move clean (no scale jump from one finger)
		r.step(InkAction.POINTER_UP, apart, 1, surface, listOf(box))
		val one = r.step(InkAction.MOVE, listOf(p(0, 60f, 530f, finger)), 0, surface, listOf(box))
		assertEquals(1f, one.scale, 0.001f)
		assertEquals(10f, one.panDx, 0.001f)
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

	@Test fun aMouseDrawsWithItsPrimaryButtonButItsMiddleAndSecondaryButtonsBelongToThePage() {
		val mouse = InkRouter.TOOL_TYPE_MOUSE
		fun InkRouter.press(buttons: Int) = step(InkAction.DOWN, listOf(InkPointer(0, 50f, 500f, mouse, buttons)), 0, surface, listOf(box)).route
		assertEquals(InkRoute.INK, InkRouter().press(1))
		assertEquals("middle button", InkRoute.WEB, InkRouter().press(4))
		assertEquals("secondary button", InkRoute.WEB, InkRouter().press(2))
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

/** M16: the ink follows one pointer by id, a stylus after a palm takes over, a cancelled pointer never draws. */
class InkRouterPalmTest {
	private val surface = InkRect(0f, 100f, 400f, 600f)
	private val finger = 1
	private val stylus = InkRouter.TOOL_TYPE_STYLUS
	private fun p(id: Int, x: Float, y: Float, tool: Int) = InkPointer(id, x, y, tool)
	private fun InkRouter.step(action: InkAction, pointers: List<InkPointer>, index: Int, canceled: Boolean = false) =
		step(action, pointers, index, surface, emptyList(), canceled)

	@Test fun theStylusIsFollowedByItsIdWhileAPalmLandsBesideIt() {
		val r = InkRouter()
		val down = r.step(InkAction.DOWN, listOf(p(7, 50f, 500f, stylus)), 0)
		assertEquals(InkRoute.INK, down.route)
		assertEquals(7, down.inkPointerId)
		val palm = listOf(p(7, 50f, 500f, stylus), p(8, 90f, 560f, finger))
		val both = r.step(InkAction.POINTER_DOWN, palm, 1)
		assertEquals(InkRoute.INK, both.route)
		assertEquals("still the stylus", 7, both.inkPointerId)
		assertFalse(both.cancelInk)
		assertEquals(7, r.step(InkAction.MOVE, palm, 0).inkPointerId)
	}

	@Test fun whenTheStylusLiftsFirstTheStrokeEndsAndThePalmIsSwallowed() {
		val r = InkRouter()
		r.step(InkAction.DOWN, listOf(p(7, 50f, 500f, stylus)), 0)
		val both = listOf(p(7, 50f, 500f, stylus), p(8, 90f, 560f, finger))
		r.step(InkAction.POINTER_DOWN, both, 1)
		val lift = r.step(InkAction.POINTER_UP, both, 0)
		assertEquals(InkRoute.INK, lift.route)
		assertTrue("the stroke ends here", lift.finishInk)
		assertEquals(7, lift.inkPointerId)
		// what the palm does from now on goes nowhere
		assertEquals(InkRoute.NONE, r.step(InkAction.MOVE, listOf(p(8, 95f, 565f, finger)), 0).route)
		assertEquals(InkRoute.NONE, r.step(InkAction.UP, listOf(p(8, 95f, 565f, finger)), 0).route)
	}

	@Test fun aPalmLiftingFirstChangesNothing() {
		val r = InkRouter()
		r.step(InkAction.DOWN, listOf(p(7, 50f, 500f, stylus)), 0)
		val both = listOf(p(7, 50f, 500f, stylus), p(8, 90f, 560f, finger))
		r.step(InkAction.POINTER_DOWN, both, 1)
		val lift = r.step(InkAction.POINTER_UP, both, 1)
		assertEquals(InkRoute.INK, lift.route)
		assertFalse(lift.finishInk)
		assertEquals(7, lift.inkPointerId)
	}

	@Test fun aPointerTheSystemCancelledNeverEndsOrStartsAStrokeOfItsOwn() {
		val r = InkRouter()
		r.step(InkAction.DOWN, listOf(p(7, 50f, 500f, stylus)), 0)
		val both = listOf(p(7, 50f, 500f, stylus), p(8, 90f, 560f, finger))
		r.step(InkAction.POINTER_DOWN, both, 1)
		// the palm (id 8) is taken back: the stylus carries on
		val palmCancelled = r.step(InkAction.POINTER_UP, both, 1, canceled = true)
		assertFalse(palmCancelled.cancelInk)
		assertFalse(palmCancelled.finishInk)
		// the stylus itself taken back: its stroke is dropped, not committed
		val penCancelled = r.step(InkAction.POINTER_UP, both, 0, canceled = true)
		assertTrue(penCancelled.cancelInk)
		assertFalse(penCancelled.finishInk)
	}

	@Test fun aCancelledLastLiftDropsTheStroke() {
		val r = InkRouter()
		r.step(InkAction.DOWN, listOf(p(7, 50f, 500f, stylus)), 0)
		val up = r.step(InkAction.UP, listOf(p(7, 50f, 500f, stylus)), 0, canceled = true)
		assertTrue(up.cancelInk)
		assertEquals(7, up.inkPointerId)
	}

	@Test fun aStylusLandingAfterAPalmTakesTheGestureOver() {
		val r = InkRouter()
		// the stylus was seen before, so a palm's DOWN goes to the page
		r.step(InkAction.DOWN, listOf(p(1, 50f, 500f, stylus)), 0)
		r.step(InkAction.UP, listOf(p(1, 50f, 500f, stylus)), 0)
		val palm = r.step(InkAction.DOWN, listOf(p(8, 90f, 560f, finger)), 0)
		assertEquals(InkRoute.WEB, palm.route)
		val both = listOf(p(8, 90f, 560f, finger), p(9, 50f, 500f, stylus))
		val takeover = r.step(InkAction.POINTER_DOWN, both, 1)
		assertEquals(InkRoute.INK, takeover.route)
		assertTrue("the stylus' POINTER_DOWN begins the stroke", takeover.startInk)
		assertTrue("the palm the page was following is cancelled", takeover.cancelWeb)
		assertEquals(9, takeover.inkPointerId)
		assertEquals("then it is followed by its id", 9, r.step(InkAction.MOVE, both, 0).inkPointerId)
	}

	@Test fun aFingerLandingAfterAFingerOnThePageDoesNotTakeOver() {
		val r = InkRouter()
		r.step(InkAction.DOWN, listOf(p(1, 50f, 500f, stylus)), 0)
		r.step(InkAction.UP, listOf(p(1, 50f, 500f, stylus)), 0)
		r.step(InkAction.DOWN, listOf(p(8, 90f, 560f, finger)), 0)
		val second = r.step(InkAction.POINTER_DOWN, listOf(p(8, 90f, 560f, finger), p(9, 150f, 560f, finger)), 1)
		assertEquals(InkRoute.WEB, second.route)
		assertFalse(second.startInk)
		assertFalse(second.cancelWeb)
	}
}
