/**
 * The course title that never clips (owner, 2026-11-14): the font size that fits one line, and the field's markup.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FitTitleInput, TITLE_MAX_LINES, TITLE_MAX_PX, TITLE_MIN_PX, fitFontPx } from "../components/fit-title-input.tsx";

describe("the title's font size", () => {
	it("is the largest size while the title fits", () => {
		assert.equal(fitFontPx(200, 600), TITLE_MAX_PX);
		assert.equal(fitFontPx(600, 600), TITLE_MAX_PX, "a title exactly as wide as the room still fits");
	});

	it("shrinks in proportion when the title is wider than the room", () => {
		// 900 px wide at the largest size in 600 px of room: two thirds of the size
		assert.equal(fitFontPx(900, 600), 20);
		assert.equal(fitFontPx(900, 450), TITLE_MIN_PX, "half the size would be 15 px: held at the floor");
		assert.equal(fitFontPx(1000, 800, 30, 10), 24);
	});

	it("never goes below the smallest size", () => {
		assert.equal(fitFontPx(5000, 300), TITLE_MIN_PX);
		assert.equal(fitFontPx(1e9, 1), TITLE_MIN_PX);
	});

	it("falls back to the largest size when a width is unknown", () => {
		for (const [width, room] of [[0, 400], [300, 0], [NaN, 400], [300, NaN], [-1, 400]] as const) assert.equal(fitFontPx(width, room), TITLE_MAX_PX, `${width} in ${room}`);
	});
});

describe("the title field", () => {
	it("is one wrapping field with the title, the largest size first, and a cap on its height", () => {
		const html = renderToStaticMarkup(<FitTitleInput value="Matte 1" onChange={() => {}} aria-label="Course title" data-testid="course-title" className="x" />);
		assert.match(html, /^<textarea[^>]*data-testid="course-title"/);
		assert.match(html, /aria-label="Course title"/);
		assert.match(html, new RegExp(`font-size:${TITLE_MAX_PX}px`));
		assert.match(html, new RegExp(`max-height:${TITLE_MAX_LINES * 1.25}em`));
		assert.match(html, />Matte 1<\/textarea>/, "the value is the title");
		assert.match(html, /rows="1"/);
	});
});
