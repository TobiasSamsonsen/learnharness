import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { CLARIFY_ANCHOR_MAX } from "../src/core/contracts/chat.ts";
import { anchorText, findAnchorRange, findQuoteRanges, passagesOf, spreadBubbles } from "../components/clarify-anchor.ts";

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

describe("passagesOf and findAnchorRange — a question's wording is told apart from the lesson prose", () => {
	const DOM = `
		<div class="lh-source-passage" data-source-message-id="m1"><p>The rule in the lesson.</p></div>
		<div class="lh-source-passage" data-source-message-id="m1" data-source-call-id="c1"><p>State the rule here.</p></div>
		<div class="lh-source-passage" data-source-message-id="m1" data-source-call-id="c2"><p>Another rule.</p></div>
	`;

	it("without a callId only the lesson prose, with one only that question's wording", () => {
		const doc = docWith(DOM);
		assert.equal(passagesOf(doc, "m1").length, 1);
		assert.equal(passagesOf(doc, "m1", "c1").length, 1);
		assert.equal(passagesOf(doc, "m1", "c2").length, 1);
		assert.equal(passagesOf(doc, "m1", "c3").length, 0);
	});

	it("an anchor with a callId finds its text in that question's wording, never in the lesson's", () => {
		const doc = docWith(DOM);
		const range = findAnchorRange(doc, { messageId: "m1", text: "the rule", occurrence: 0, callId: "c1" });
		assert.ok(range);
		assert.equal(range.startContainer, textNodeOf(doc, ".lh-source-passage", 1));
		const lesson = findAnchorRange(doc, { messageId: "m1", text: "the rule", occurrence: 0 });
		assert.equal(lesson?.startContainer, textNodeOf(doc, ".lh-source-passage", 0));
	});

	it("a question's anchor is not found once its wording is off the page (a different or missing call)", () => {
		const doc = docWith(DOM);
		assert.equal(findAnchorRange(doc, { messageId: "m1", text: "State the rule", occurrence: 0, callId: "c2" }), null);
		assert.equal(findAnchorRange(doc, { messageId: "m1", text: "State the rule", occurrence: 0, callId: "gone" }), null);
	});
});

describe("findQuoteRanges — every line of the marked text", () => {
	// <br> splits display runs in test DOMs (no CSS OM), as a block boundary does in the browser: each line is its own run.
	const passage = (html: string, attrs = "") => `<div class="lh-source-passage" data-source-message-id="m1"${attrs}><p>${html}</p></div>`;
	const textOf = (range: { startContainer: Node }) => (range.startContainer as Text).data;

	it("a selection over three lines gives one range per line, in order", () => {
		const doc = docWith(passage("Intro<br>The rule says A<br>and then B<br>Outro"));
		const anchor = { messageId: "m1", text: "The rule says A", occurrence: 0 };
		const ranges = findQuoteRanges(doc, anchor, "The rule says A\nand then B");
		assert.deepEqual(ranges.map(textOf), ["The rule says A", "and then B"]);
		assert.equal(ranges[1]!.startOffset, 0);
		assert.equal(ranges[1]!.endOffset, "and then B".length);
	});

	it("a later line is searched for after the previous one, not at an earlier twin", () => {
		const doc = docWith(passage("B<br>The rule<br>B<br>end"));
		const ranges = findQuoteRanges(doc, { messageId: "m1", text: "The rule", occurrence: 0 }, "The rule\nB");
		assert.equal(ranges.length, 2);
		const nodes = [...doc.querySelectorAll("p")[0]!.childNodes].filter((n) => n.nodeType === 3);
		assert.equal(ranges[1]!.startContainer, nodes[2], "the B after the rule, not the B before it");
	});

	it("a line that is not on the page is skipped and what was found stays", () => {
		const doc = docWith(passage("Intro<br>The rule<br>Outro"));
		const ranges = findQuoteRanges(doc, { messageId: "m1", text: "The rule", occurrence: 0 }, "The rule\nnot there\nOutro");
		assert.deepEqual(ranges.map(textOf), ["The rule", "Outro"]);
	});

	it("no range at all once the anchor line itself is gone", () => {
		const doc = docWith(passage("Intro<br>Outro"));
		assert.deepEqual(findQuoteRanges(doc, { messageId: "m1", text: "The rule", occurrence: 0 }, "The rule\nOutro"), []);
	});

	it("a first line the anchor capped is widened to its full text", () => {
		const line = `${"word ".repeat(80)}end`;
		const capped = anchorText(line);
		assert.ok(capped.length < line.length, "the anchor line is capped");
		const doc = docWith(passage(line));
		const [range] = findQuoteRanges(doc, { messageId: "m1", text: capped, occurrence: 0 }, line);
		assert.equal(range!.startOffset, 0);
		assert.equal(range!.endOffset, line.length, "the range covers the whole line");
	});

	it("an empty quote still marks the anchor line", () => {
		const doc = docWith(passage("The rule"));
		assert.equal(findQuoteRanges(doc, { messageId: "m1", text: "The rule", occurrence: 0 }, "").length, 1);
	});

	it("a question's wording is searched under its callId only", () => {
		const doc = docWith(
			passage("The rule in the lesson") +
				`<div class="lh-source-passage" data-source-message-id="m1" data-source-call-id="c1"><p>State the rule<br>and prove it</p></div>`,
		);
		const ranges = findQuoteRanges(doc, { messageId: "m1", text: "the rule", occurrence: 0, callId: "c1" }, "the rule\nand prove it");
		assert.deepEqual(ranges.map(textOf), ["State the rule", "and prove it"]);
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
