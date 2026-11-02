import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { CLARIFY_ANCHOR_MAX } from "../src/core/contracts/chat.ts";
import { anchorText, findAnchorRange, passagesOf, spreadBubbles } from "../components/clarify-anchor.ts";

// The DOM seam is linkedom, as in tests/session-find.test.tsx. linkedom has no live Selection, and its Range
// lacks setStart in some builds, so sessionPassageRanges falls back to its StaticRangeLike stand-in; the
// assertions compare the start container and offset, which both paths expose.

function docWith(html: string): Document {
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	return document as unknown as Document;
}

/** The text node of the paragraph inside the n-th element matching the selector (each fixture passage is one <p>). */
function textNodeOf(doc: Document, selector: string, index = 0): Node {
	const el = doc.querySelectorAll(selector)[index];
	assert.ok(el, `found ${selector} #${index}`);
	const text = el.querySelector("p")?.firstChild;
	assert.ok(text && text.nodeType === 3, "a text node");
	return text;
}

describe("anchorText — the first displayed line of the marked text", () => {
	it("takes the first non-empty line, trimmed", () => {
		assert.equal(anchorText("  first line here \n second line"), "first line here");
	});

	it("skips leading blank lines", () => {
		assert.equal(anchorText("\n\n  \nreal line\nnext"), "real line");
	});

	it("collapses inner whitespace runs to single spaces", () => {
		assert.equal(anchorText("a   b\t c"), "a b c");
	});

	it("is empty for blank input", () => {
		assert.equal(anchorText(""), "");
		assert.equal(anchorText(" \n\t \n"), "");
	});

	it("caps at CLARIFY_ANCHOR_MAX, with no trailing space", () => {
		const long = anchorText("word ".repeat(200));
		assert.ok(long.length <= CLARIFY_ANCHOR_MAX, "within the cap");
		assert.ok(long.length > CLARIFY_ANCHOR_MAX - 10, "the cap is what cuts it");
		assert.equal(long, long.trimEnd(), "no trailing space after the cut");
		assert.equal(anchorText("x".repeat(CLARIFY_ANCHOR_MAX + 50)).length, CLARIFY_ANCHOR_MAX);
	});
});

describe("spreadBubbles — bubbles on neighbouring lines do not stack", () => {
	it("already-spaced tops come back unchanged", () => {
		assert.deepEqual(spreadBubbles([10, 100, 200], 36), [10, 100, 200]);
	});

	it("clustered tops are pushed down to at least the gap apart", () => {
		assert.deepEqual(spreadBubbles([10, 12, 14], 36), [10, 46, 82]);
	});

	it("the output keeps the input order, not the sorted order", () => {
		// sorted: 10 (index 1), 12 (index 2), 50 (index 0)
		assert.deepEqual(spreadBubbles([50, 10, 12], 36), [82, 10, 46]);
	});

	it("ties keep their input order", () => {
		assert.deepEqual(spreadBubbles([20, 20, 20], 10), [20, 30, 40]);
	});

	it("every neighbour pair is at least the gap apart", () => {
		const tops = [5, 5, 9, 40, 41, 42, 200, 201];
		const placed = spreadBubbles(tops, 24);
		const sorted = [...placed].sort((a, b) => a - b);
		for (let i = 1; i < sorted.length; i++) {
			assert.ok(sorted[i]! - sorted[i - 1]! >= 24, `gap between ${sorted[i - 1]} and ${sorted[i]}`);
		}
		placed.forEach((top, i) => assert.ok(top >= tops[i]!, "never moved up"));
	});

	it("empty input gives empty output", () => {
		assert.deepEqual(spreadBubbles([], 36), []);
	});
});

describe("passagesOf — the passages of one message", () => {
	it("returns only the passages of that message, in document order", () => {
		const doc = docWith(`
			<div class="lh-source-passage" data-source-message-id="m1" id="a"><p>one</p></div>
			<div class="lh-source-passage" data-source-message-id="m2" id="b"><p>two</p></div>
			<div data-source-message-id="m1" id="not-a-passage"><p>three</p></div>
			<div class="lh-source-passage" data-source-message-id="m1" id="c"><p>four</p></div>
		`);
		const found = passagesOf(doc, "m1");
		assert.equal(found.length, 2);
		assert.equal(found[0]!.id, "a");
		assert.equal(found[1]!.id, "c");
		assert.equal(passagesOf(doc, "m_none").length, 0);
	});
});

describe("findAnchorRange — re-finding the line by its occurrence", () => {
	const DOM = `
		<div class="lh-source-passage" data-source-message-id="m1"><p>Alpha the rule. Beta</p></div>
		<div class="lh-source-passage" data-source-message-id="m1"><p>Gamma the rule.</p></div>
		<div class="lh-source-passage" data-source-message-id="m2"><p>the rule elsewhere</p></div>
		<div class="lh-source-passage" data-source-message-id="m3"><p>the   rule
			and more</p></div>
	`;

	it("occurrence 0 and occurrence 1 return different ranges, one per passage", () => {
		const doc = docWith(DOM);
		const first = findAnchorRange(doc, { messageId: "m1", text: "the rule", occurrence: 0 });
		const second = findAnchorRange(doc, { messageId: "m1", text: "the rule", occurrence: 1 });
		assert.ok(first && second, "both found");
		assert.equal(first.startContainer, textNodeOf(doc, ".lh-source-passage", 0), "occurrence 0 is in the first passage");
		assert.equal(second.startContainer, textNodeOf(doc, ".lh-source-passage", 1), "occurrence 1 is in the second passage");
		assert.notEqual(first.startContainer, second.startContainer);
		assert.equal(first.startOffset, "Alpha ".length);
		assert.equal(second.startOffset, "Gamma ".length);
	});

	it("an occurrence beyond the count falls back to the last one", () => {
		const doc = docWith(DOM);
		const last = findAnchorRange(doc, { messageId: "m1", text: "the rule", occurrence: 1 });
		const beyond = findAnchorRange(doc, { messageId: "m1", text: "the rule", occurrence: 7 });
		assert.ok(last && beyond);
		assert.equal(beyond.startContainer, last.startContainer);
		assert.equal(beyond.startOffset, last.startOffset);
	});

	it("a text that is no longer on the page gives null", () => {
		const doc = docWith(DOM);
		assert.equal(findAnchorRange(doc, { messageId: "m1", text: "nowhere to be found", occurrence: 0 }), null);
	});

	it("only the anchor's own message is searched", () => {
		const doc = docWith(DOM);
		const range = findAnchorRange(doc, { messageId: "m2", text: "the rule", occurrence: 0 });
		assert.ok(range);
		assert.equal(range.startContainer, textNodeOf(doc, ".lh-source-passage", 2));
		assert.equal(findAnchorRange(doc, { messageId: "m2", text: "the rule", occurrence: 1 })?.startContainer, range.startContainer);
	});

	it("matching is case-insensitive", () => {
		const doc = docWith(DOM);
		const range = findAnchorRange(doc, { messageId: "m1", text: "THE RULE", occurrence: 1 });
		assert.ok(range);
		assert.equal(range.startContainer, textNodeOf(doc, ".lh-source-passage", 1));
	});

	it("matching is whitespace-collapsed across the markup's line breaks and runs of spaces", () => {
		const doc = docWith(DOM);
		const range = findAnchorRange(doc, { messageId: "m3", text: "the rule and more", occurrence: 0 });
		assert.ok(range, "the collapsed phrase matches");
		assert.equal(range.startContainer, textNodeOf(doc, ".lh-source-passage", 3));
		assert.equal(range.startOffset, 0);
	});
});
