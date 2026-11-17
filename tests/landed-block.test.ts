import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockScrollTarget, isLandedText, isLongBlock, revealStagger, wordCount, REVEAL_MS } from "../components/landed-block.ts";

describe("landed block helpers", () => {
	it("treats a text with many characters at first render as landed, a few characters as streaming", () => {
		assert.equal(isLandedText("Hei"), false);
		assert.equal(isLandedText("x".repeat(119)), false);
		assert.equal(isLandedText("x".repeat(120)), true);
	});

	it("a block is long when it fills more than half the viewport", () => {
		assert.equal(isLongBlock(800, 786), true);
		assert.equal(isLongBlock(788, 786), true, "the plan on the tablet: 788 px against 786");
		assert.equal(isLongBlock(400, 786), true);
		assert.equal(isLongBlock(393, 786), false);
		assert.equal(isLongBlock(200, 786), false);
		assert.equal(isLongBlock(900, 0), false);
	});

	it("the stagger makes the sweep last about REVEAL_MS and stays in bounds", () => {
		assert.equal(Math.round(revealStagger(120) * 120), REVEAL_MS);
		assert.equal(revealStagger(1), 40, "a one-word text is capped, not 1200 ms per word");
		assert.equal(revealStagger(100000), 0.5, "a huge text keeps a floor");
		assert.equal(revealStagger(0), 40);
	});

	it("counts words", () => {
		assert.equal(wordCount("  to ord  "), 2);
		assert.equal(wordCount(""), 0);
	});

	it("puts the block's first line a quarter of the way down", () => {
		assert.equal(blockScrollTarget({ blockTop: 1000, viewportHeight: 800, scrollHeight: 4000 }), 800);
	});

	it("keeps the target inside the scroll range", () => {
		assert.equal(blockScrollTarget({ blockTop: 100, viewportHeight: 800, scrollHeight: 4000 }), 0, "never above the top");
		assert.equal(blockScrollTarget({ blockTop: 3900, viewportHeight: 800, scrollHeight: 4000 }), 3200, "never past the bottom");
		assert.equal(blockScrollTarget({ blockTop: 500, viewportHeight: 800, scrollHeight: 600 }), 0, "short content cannot scroll");
	});
});
