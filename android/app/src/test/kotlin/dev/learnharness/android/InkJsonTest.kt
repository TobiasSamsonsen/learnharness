package dev.learnharness.android

import java.util.Random
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class InkJsonTest {
	/** The quick reader and the general one must agree on every line: same strokes, or both reject it. */
	private fun same(json: String) {
		val fast = InkWire.strokes(json)
		val slow = InkWire.strokesGeneral(json)
		if (slow == null) {
			assertNull("both reject: $json", fast)
			return
		}
		assertNotNull("both accept: $json", fast)
		assertEquals(slow.size, fast!!.size)
		for (i in slow.indices) {
			assertEquals(slow[i].size, fast[i].size, 0f)
			assertEquals(slow[i].color, fast[i].color)
			assertEquals(slow[i].sent, fast[i].sent)
			assertArrayEquals(slow[i].points, fast[i].points, 0f)
		}
	}

	@Test fun readsWhatThePageWrites() {
		val json = """[{"size":4,"points":[0,0,0.5,10.25,-3.5,0.75]},{"size":2.5,"color":"#ff00aa","points":[1,2,0.5],"fresh":false}]"""
		val s = InkJson.strokes(json)!!
		assertEquals(2, s.size)
		assertEquals(4f, s[0].size, 0f)
		assertEquals(false, s[0].sent)
		assertArrayEquals(floatArrayOf(0f, 0f, 0.5f, 10.25f, -3.5f, 0.75f), s[0].points, 0f)
		assertEquals("#ff00aa", s[1].color)
		assertEquals(true, s[1].sent)
		same(json)
	}

	@Test fun agreesWithTheGeneralReaderOnManyRandomPages() {
		val rnd = Random(7)
		repeat(60) {
			val strokes = (0 until rnd.nextInt(6)).joinToString(",", "[", "]") { _ ->
				val pts = (0 until rnd.nextInt(8) * 3).joinToString(",") { k ->
					when (k % 3) {
						2 -> "0." + (rnd.nextInt(99) + 1)
						else -> "%.1f".format(java.util.Locale.ROOT, (rnd.nextDouble() - 0.3) * 4000)
					}
				}
				val extra = when (rnd.nextInt(4)) { 0 -> ""","color":"#a1B2c3"""" ; 1 -> ""","fresh":false""" ; 2 -> ""","fresh":true""" ; else -> "" }
				"""{"size":${rnd.nextInt(60) + 1},"points":[$pts]$extra}"""
			}
			same(strokes)
		}
	}

	@Test fun readsTheNumbersTheSameWay_exponentsLongDecimalsAndIntegers() {
		same("""[{"size":4,"points":[1e2,2E-1,0.5, 123456789012345678,0.1234567890123456789,0.5, -0,-0.0,1]}]""")
		same("""[{"size":4,"points":[0.30000000000000004,16777217,0.5]}]""")
	}

	@Test fun toleratesWhitespaceAndAnyKeyOrder() {
		same("""[ { "points" : [ 1 , 2 , 0.5 ] , "fresh" : false , "size" : 3 } ]""")
		same("""[]""")
		same("""  []  """)
	}

	@Test fun whatItDoesNotRecogniseGoesToTheGeneralReader() {
		// an unknown key, an escaped colour, a colour that is not #rrggbb, a duplicated key: same answer either way
		same("""[{"size":4,"points":[1,2,0.5],"note":"x"}]""")
		same("""[{"size":4,"color":"#124456","points":[1,2,0.5]}]""")
		same("""[{"size":4,"color":"red","points":[1,2,0.5]}]""")
		same("""[{"size":4,"size":5,"points":[1,2,0.5]}]""")
	}

	@Test fun rejectsWhatBreaksARule_likeTheGeneralReader() {
		same("""[{"size":4,"points":[1,2]}]""") // not triples
		same("""[{"size":0,"points":[1,2,0.5]}]""") // no width
		same("""[{"size":-1,"points":[1,2,0.5]}]""")
		same("""[{"points":[1,2,0.5]}]""") // no size
		same("""[{"size":4}]""") // no points
		same("""[{"size":4,"points":[1,2,0.5]""") // cut off
		same("""[{"size":4,"points":[1,2,0.5]}] junk""")
		same("""not json""")
		same("""[{"size":4,"points":[1e999,2,0.5]}]""") // not finite
	}
}
