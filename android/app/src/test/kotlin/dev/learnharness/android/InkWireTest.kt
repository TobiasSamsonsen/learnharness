package dev.learnharness.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InkWireTest {
	@Test fun parsesTheLinesTheWebSends() {
		assertEquals(InkOp.Open("call_abc-1", InkRect(0f, 120.46f, 411f, 640f)), InkWire.parse("open call_abc-1 0 120.46 411 640"))
		assertEquals(
			InkOp.Holes(listOf(InkRect(8f, 8f, 300f, 200f), InkRect(10.5f, 250f, 100f, 40f))),
			InkWire.parse("holes 8,8,300,200 10.5,250,100,40"),
		)
		assertEquals(InkOp.Holes(emptyList()), InkWire.parse("holes"))
		assertEquals(InkOp.Tool(eraser = true), InkWire.parse("tool eraser"))
		assertEquals(InkOp.Tool(eraser = false), InkWire.parse(" tool pen "))
		assertEquals(InkOp.Undo, InkWire.parse("undo"))
		assertEquals(InkOp.Redo, InkWire.parse("redo"))
		assertEquals(InkOp.Clear, InkWire.parse("clear"))
		assertEquals(InkOp.Close, InkWire.parse("close"))
		assertEquals(InkOp.Export, InkWire.parse("export"))
	}

	@Test fun refusesAnythingElseWithoutThrowing() {
		for (bad in listOf("", "nonsense", "open", "open bad!key 0 0 1 1", "open k 0 0 1", "open k a b c d", "holes 1,2,3", "holes x,y,z,w", "tool brush", "tool", "undo now", "export all")) {
			assertNull(bad, InkWire.parse(bad))
		}
	}

	@Test fun strokesBecomeSketchStrokeJson() {
		val json = InkWire.strokesJson(
			listOf(
				InkWire.Stroke(3f, null, floatArrayOf(10f, 20f, 0.5f, 11.255f, 21f, 1f)),
				InkWire.Stroke(2.5f, "#ff0000", floatArrayOf(1f, 2f, 0f)),
			),
		)
		assertEquals(
			"[{\"size\":3,\"points\":[10,20,0.5,11.26,21,1]},{\"size\":2.5,\"color\":\"#ff0000\",\"points\":[1,2,0]}]",
			json,
		)
		assertEquals("[]", InkWire.strokesJson(emptyList()))
	}

	@Test fun routingGivesThePenTheSurfaceExceptWhereWebUiSits() {
		val surface = InkRect(0f, 100f, 400f, 600f)
		val box = InkRect(10f, 110f, 300f, 200f)
		val pen = InkRouting.TOOL_TYPE_STYLUS
		assertEquals(InkTarget.INK, InkRouting.route(pen, 50f, 500f, surface, listOf(box)))
		assertEquals(InkTarget.INK, InkRouting.route(InkRouting.TOOL_TYPE_ERASER, 50f, 500f, surface, listOf(box)))
		assertEquals("on the floating box", InkTarget.WEB, InkRouting.route(pen, 50f, 150f, surface, listOf(box)))
		assertEquals("above the surface", InkTarget.WEB, InkRouting.route(pen, 50f, 50f, surface, listOf(box)))
		assertEquals("a finger pans the page", InkTarget.WEB, InkRouting.route(1, 50f, 500f, surface, listOf(box)))
		assertEquals("a mouse", InkTarget.WEB, InkRouting.route(3, 50f, 500f, surface, emptyList()))
		assertEquals("no surface open", InkTarget.WEB, InkRouting.route(pen, 50f, 500f, null, emptyList()))
		assertTrue("edges count as inside", InkRect(0f, 0f, 10f, 10f).contains(10f, 10f))
	}
}
