package dev.learnharness.android

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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
		assertEquals(InkOp.Brush("#dc2626", 8f), InkWire.parse("brush #dc2626 8"))
		assertEquals(InkOp.Brush("#111111", 2.5f), InkWire.parse(" brush #111111 2.5 "))
		assertNull(InkWire.parse("brush red 4"))
		assertNull(InkWire.parse("brush #dc2626"))
		assertNull(InkWire.parse("brush #dc2626 0"))
		assertNull(InkWire.parse("brush #dc2626 NaN"))
		assertEquals(InkOp.Scroll(312.5f), InkWire.parse("scroll 312.5"))
		assertEquals(InkOp.Ack, InkWire.parse("ack"))
		assertEquals(InkOp.Close, InkWire.parse("close"))
	}

	@Test fun parsesTheStrokeSetsTheWebPushes() {
		val op = InkWire.parse("strokes [{\"size\":4,\"points\":[10,20,0.5,11,21,0.6]},{\"size\":3,\"color\":\"#ff0000\",\"points\":[1,2,0]}]") as InkOp.Strokes
		assertEquals(2, op.strokes.size)
		assertEquals(4f, op.strokes[0].size, 0f)
		assertEquals(null, op.strokes[0].color)
		assertArrayEquals(floatArrayOf(10f, 20f, 0.5f, 11f, 21f, 0.6f), op.strokes[0].points, 0f)
		assertEquals("#ff0000", op.strokes[1].color)
		assertEquals(InkOp.Strokes(emptyList()).strokes.size, (InkWire.parse("strokes []") as InkOp.Strokes).strokes.size)
		assertTrue(InkWire.parse("kept [{\"size\":4,\"points\":[1,2,3]}]") is InkOp.Kept)
	}

	@Test fun refusesAnythingElseWithoutThrowing() {
		val bad = listOf(
			"", "nonsense", "open", "open bad!key 0 0 1 1", "open k 0 0 1", "open k a b c d",
			"open k NaN 0 1 1", "open k 0 0 Infinity 1", "holes 1,2,3", "holes x,y,z,w", "holes NaN,0,1,1",
			"tool brush", "tool", "close now", "ack now", "scroll", "scroll NaN", "scroll up",
			"strokes", "strokes nope", "strokes {}", "strokes [{\"size\":4,\"points\":[1,2]}]",
			"strokes [{\"size\":0,\"points\":[1,2,3]}]", "strokes [{\"size\":4}]", "strokes [{\"size\":4,\"points\":[1,\"x\",3]}]",
			"undo", "export",
		)
		for (line in bad) assertNull(line, InkWire.parse(line))
	}

	@Test fun anIgnoredColourIsDroppedNotTrusted() {
		val op = InkWire.parse("strokes [{\"size\":4,\"color\":\"red\",\"points\":[1,2,3]}]") as InkOp.Strokes
		assertNull(op.strokes[0].color)
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
		// a non-finite number never reaches the web as an invalid token
		assertEquals("[{\"size\":4,\"points\":[0,5,0.5]}]", InkWire.strokesJson(listOf(InkWire.Stroke(4f, null, floatArrayOf(Float.NaN, 5f, 0.5f)))))
	}

	@Test fun whatTheShellSaysBack() {
		assertEquals("stroke [{\"size\":4,\"points\":[1,2,0.5]}]", InkWire.strokeLine(InkWire.Stroke(4f, null, floatArrayOf(1f, 2f, 0.5f))))
		assertEquals("erase 1,2,3.5,4", InkWire.eraseLine(floatArrayOf(1f, 2f, 3.5f, 4f)))
		assertEquals("pan -12.5", InkWire.panLine(-12.5f))
		assertEquals("penseen", InkWire.PEN_SEEN)
		assertEquals("fallback no surface available", InkWire.fallbackLine("no\nsurface   available"))
		assertNotNull(InkWire.strokes(InkWire.strokesJson(listOf(InkWire.Stroke(4f, null, floatArrayOf(1f, 2f, 0.5f))))))
	}

	@Test fun rectEdgesCountAsInside() {
		assertTrue(InkRect(0f, 0f, 10f, 10f).contains(10f, 10f))
	}
}
