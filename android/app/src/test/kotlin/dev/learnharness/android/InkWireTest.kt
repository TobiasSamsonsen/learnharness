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
		assertEquals(InkOp.Sheet(dark = true), InkWire.parse("sheet dark"))
		assertEquals(InkOp.Sheet(dark = false), InkWire.parse(" sheet light "))
		assertNull(InkWire.parse("sheet"))
		assertNull(InkWire.parse("sheet blue"))
		assertEquals(InkOp.Brush("#dc2626", 8f), InkWire.parse("brush #dc2626 8"))
		assertEquals(InkOp.Brush("#111111", 2.5f), InkWire.parse(" brush #111111 2.5 "))
		assertNull(InkWire.parse("brush red 4"))
		assertNull(InkWire.parse("brush #dc2626"))
		assertNull(InkWire.parse("brush #dc2626 0"))
		assertNull(InkWire.parse("brush #dc2626 NaN"))
		assertEquals(InkOp.View(InkView(2.5f, -300f, 120.5f)), InkWire.parse("view 2.5 -300 120.5"))
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
			"tool brush", "tool", "close now", "ack now", "view", "view 1 2", "view 1 2 3 4", "view 0 0 0", "view 9 0 0", "view NaN 0 0", "view a b c", "scroll 1",
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
		// the layer records [x, y, pressure] triples; the line carries only the pairs (reading triples as pairs cut the wrong places)
		assertArrayEquals(floatArrayOf(1f, 2f, 4f, 5f), InkWire.xyOf(floatArrayOf(1f, 2f, 0.5f, 4f, 5f, 0.6f)), 0f)
		assertEquals("erase 1,2,4,5", InkWire.eraseLine(InkWire.xyOf(floatArrayOf(1f, 2f, 0.5f, 4f, 5f, 0.6f))))
		assertEquals(0, InkWire.xyOf(floatArrayOf()).size)
		assertEquals("gesture -12.5 3 1.5000 200 310.25", InkWire.gestureLine(-12.5f, 3f, 1.5f, 200f, 310.25f))
		assertEquals("a broken scale is no pinch", "gesture 0 0 1.0000 0 0", InkWire.gestureLine(0f, 0f, Float.NaN, 0f, 0f))
		assertEquals("penseen", InkWire.PEN_SEEN)
		assertEquals("fallback no surface available", InkWire.fallbackLine("no\nsurface   available"))
		assertNotNull(InkWire.strokes(InkWire.strokesJson(listOf(InkWire.Stroke(4f, null, floatArrayOf(1f, 2f, 0.5f))))))
	}

	@Test fun rectEdgesCountAsInside() {
		assertTrue(InkRect(0f, 0f, 10f, 10f).contains(10f, 10f))
	}
}

class InkWireEraserTest {
	private fun stroke(vararg xy: Float, size: Float = 4f) = InkWire.Stroke(size, null, FloatArray(xy.size / 2 * 3) { k -> if (k % 3 == 2) 0.5f else xy[(k / 3) * 2 + k % 3] })

	@org.junit.Test fun theEraserLineCarriesModeAndReach() {
		org.junit.Assert.assertEquals(InkOp.Eraser(true, 20f), InkWire.parse("eraser stroke 20"))
		org.junit.Assert.assertEquals(InkOp.Eraser(false, 10.5f), InkWire.parse("eraser pixel 10.5"))
		for (bad in listOf("eraser", "eraser stroke", "eraser big 20", "eraser stroke 0", "eraser stroke 500", "eraser stroke x", "eraser stroke 20 3")) {
			org.junit.Assert.assertNull(bad, InkWire.parse(bad))
		}
	}

	@org.junit.Test fun aStrokeIsHitWithinTheReachPlusHalfItsWidth() {
		val s = stroke(0f, 0f, 100f, 0f) // size 4: reach r + 2
		org.junit.Assert.assertTrue(InkWire.strokeHit(s, 50f, 10f, 8f)) // 10 px away, reach 10
		org.junit.Assert.assertFalse(InkWire.strokeHit(s, 50f, 11f, 8f))
		org.junit.Assert.assertTrue("past the end, near the end point", InkWire.strokeHit(s, 105f, 0f, 4f))
		org.junit.Assert.assertFalse(InkWire.strokeHit(s, 110f, 0f, 4f))
		org.junit.Assert.assertFalse("a stroke with no points is never hit", InkWire.strokeHit(InkWire.Stroke(4f, null, FloatArray(0)), 0f, 0f, 50f))
	}

	@org.junit.Test fun sentInkIsTheStrokesTheWebMarksFreshFalse() {
		// the page's local marker for sent ink it copied into the working page: drawn dimmed. Anything else (absent, true) is new ink.
		val parsed = InkWire.strokes(
			"[{\"size\":4,\"fresh\":false,\"points\":[1,2,0.5]},{\"size\":4,\"fresh\":true,\"points\":[1,2,0.5]},{\"size\":4,\"points\":[1,2,0.5]},{\"size\":4,\"color\":\"#ff0000\",\"fresh\":false,\"points\":[3,4,0.5,5,6,0.5]}]",
		)!!
		org.junit.Assert.assertEquals(listOf(true, false, false, true), parsed.map { it.sent })
		org.junit.Assert.assertEquals("a colour survives alongside the marker", "#ff0000", parsed[3].color)
		org.junit.Assert.assertFalse("a stroke the shell draws itself is never sent ink", InkWire.Stroke(4f, null, floatArrayOf(1f, 2f, 0.5f)).sent)
		// the marker is not echoed back: the shell never reports a stroke as sent
		org.junit.Assert.assertFalse(InkWire.strokesJson(listOf(parsed[0])).contains("fresh"))
	}

	@org.junit.Test fun theCapsLineAndTheErasedLine() {
		org.junit.Assert.assertEquals(InkOp.Caps(hits = true), InkWire.parse("caps hits"))
		org.junit.Assert.assertEquals(InkOp.Caps(hits = true), InkWire.parse(" caps hits "))
		for (bad in listOf("caps", "caps nothing", "caps hits more", "capshits")) org.junit.Assert.assertNull(bad, InkWire.parse(bad))
		org.junit.Assert.assertEquals("erased 5 0,3,4", InkWire.erasedLine(5, setOf(4, 0, 3)))
		org.junit.Assert.assertEquals("erased 5", InkWire.erasedLine(5, emptySet()))
		org.junit.Assert.assertEquals("erased 0", InkWire.erasedLine(0, emptyList()))
	}

	/** The plain walk, as strokeHit was before the bounding box: the reference every answer is held to. */
	private fun walk(s: InkWire.Stroke, x: Float, y: Float, r: Float): Boolean {
		val p = s.points
		if (p.size < 3) return false
		val reach = r + s.size / 2f
		var px = p[0]
		var py = p[1]
		if (kotlin.math.hypot((x - px).toDouble(), (y - py).toDouble()) <= reach) return true
		var k = 3
		while (k + 1 < p.size) {
			val qx = p[k]
			val qy = p[k + 1]
			val dx = qx - px
			val dy = qy - py
			val len2 = dx * dx + dy * dy
			val t = if (len2 == 0f) 0f else (((x - px) * dx + (y - py) * dy) / len2).coerceIn(0f, 1f)
			if (kotlin.math.hypot((x - (px + t * dx)).toDouble(), (y - (py + t * dy)).toDouble()) <= reach) return true
			px = qx
			py = qy
			k += 3
		}
		return false
	}

	@org.junit.Test fun theBoundingBoxShortcutNeverChangesAnAnswer() {
		val rnd = java.util.Random(11)
		val strokes = List(120) {
			val n = 1 + rnd.nextInt(40)
			var x = rnd.nextFloat() * 400f
			var y = rnd.nextFloat() * 600f
			val pts = FloatArray(n * 3)
			for (i in 0 until n) {
				x += (rnd.nextFloat() - 0.5f) * 30f
				y += (rnd.nextFloat() - 0.5f) * 30f
				pts[i * 3] = x
				pts[i * 3 + 1] = y
				pts[i * 3 + 2] = 0.5f
			}
			InkWire.Stroke(1f + rnd.nextFloat() * 9f, null, pts)
		}
		var hits = 0
		var misses = 0
		for (s in strokes) for (i in 0 until 40) {
			val x = rnd.nextFloat() * 500f - 50f
			val y = rnd.nextFloat() * 700f - 50f
			val r = floatArrayOf(0.5f, 4f, 20f, 60f, 400f)[i % 5]
			val want = walk(s, x, y, r)
			org.junit.Assert.assertEquals("point $x,$y radius $r", want, InkWire.strokeHit(s, x, y, r))
			if (want) hits++ else misses++
		}
		org.junit.Assert.assertTrue("both outcomes are sampled ($hits hits, $misses misses)", hits > 300 && misses > 300)
	}

	@org.junit.Test fun aPointerExactlyAtTheReachStillHits_andOneBeyondDoesNot() {
		val s = InkWire.Stroke(6f, null, floatArrayOf(100f, 100f, 0.5f, 200f, 100f, 0.5f)) // reach with r = 10 is 13
		org.junit.Assert.assertTrue(InkWire.strokeHit(s, 100f, 113f, 10f))
		org.junit.Assert.assertFalse(InkWire.strokeHit(s, 100f, 113.5f, 10f))
		org.junit.Assert.assertTrue(InkWire.strokeHit(s, 87f, 100f, 10f))
		org.junit.Assert.assertFalse(InkWire.strokeHit(s, 86f, 100f, 10f))
		org.junit.Assert.assertTrue(InkWire.strokeHit(s, 213f, 100f, 10f))
	}

	@org.junit.Test fun theHitsAreTheStrokesAnyPathPointTouched_andOnlyFromTheGivenPointOn() {
		val a = stroke(0f, 0f, 100f, 0f)
		val b = stroke(0f, 200f, 100f, 200f)
		val path = floatArrayOf(50f, 2f, 50f, 100f, 50f, 198f) // touches a first, then b
		org.junit.Assert.assertEquals(setOf(0, 1), InkWire.eraseHits(listOf(a, b), path, 5f))
		org.junit.Assert.assertEquals("only the newest point", setOf(1), InkWire.eraseHits(listOf(a, b), path, 5f, fromPair = 2))
		org.junit.Assert.assertEquals(emptySet<Int>(), InkWire.eraseHits(listOf(a, b), floatArrayOf(50f, 100f), 5f))
	}
}
