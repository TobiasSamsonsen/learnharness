import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { teaserText } from "../components/teaser-text.ts";

describe("teaserText: the one-line preview of a question", () => {
	it("flattens limits and arrows (the card used to read `lim_xto0g(x)`)", () => {
		assert.equal(teaserText("What is $\\lim_{x\\to 0} g(x)$?"), "What is lim_x → 0 g(x)?");
	});

	it("drops markdown emphasis, code and headings", () => {
		assert.equal(teaserText("Think about **which values the loop variable takes** and `i`"), "Think about which values the loop variable takes and i");
		assert.equal(teaserText("## Setup\nRead this ```python\nprint(1)\n``` now"), "Setup Read this code now");
		assert.equal(teaserText("See [the notes](https://example.com) first"), "See the notes first");
		assert.equal(teaserText("What does `__init__` do in `class A`?"), "What does __init__ do in class A?");
	});

	it("turns greek letters, relations, fractions and roots into symbols", () => {
		assert.equal(teaserText("Pick $\\varepsilon>0$ and $\\delta$ with $|x-a|\\le\\delta$"), "Pick ε>0 and δ with |x-a| ≤ δ");
		assert.equal(teaserText("$\\frac{x^2-9}{x-3}$ and $\\sqrt{2}$"), "(x^2-9)/(x-3) and √(2)");
	});

	it("keeps unknown commands as their bare name and leaves plain text alone", () => {
		assert.equal(teaserText("$\\sin x$"), "sin x");
		assert.equal(teaserText("Which planet is closest to the sun?"), "Which planet is closest to the sun?");
		assert.equal(teaserText(""), "");
	});
});
