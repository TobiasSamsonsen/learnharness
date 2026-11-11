import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { currentMark } from "../components/ask-selection.tsx";

// The DOM environment is linkedom, as in tests/session-find.test.tsx (the repo's only DOM seam). linkedom has no live
// document Selection, so currentMark's selection is a small stand-in over real linkedom nodes: the scope and field checks
// run on the real elements. The stand-in's Range implements comparePoint (as the live Range does: -1 before, 0 inside,
// 1 after) from the nodes' document order, so the occurrence logic runs too.

const RECT = { top: 100, bottom: 120, left: 50, right: 150, width: 100, height: 20 };
const WIN = { innerWidth: 1000, matchMedia: () => ({ matches: false }) } as unknown as Window;

const DOCUMENT_POSITION_PRECEDING = 2;
const DOCUMENT_POSITION_FOLLOWING = 4;

function docWith(html: string) {
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	return document as unknown as Document;
}

/** Order of two boundary points in document order: -1, 0 or 1. */
function compareBoundary(aNode: Node, aOffset: number, bNode: Node, bOffset: number): number {
	if (aNode === bNode) return Math.sign(aOffset - bOffset);
	const position = aNode.compareDocumentPosition(bNode);
	if (position & DOCUMENT_POSITION_FOLLOWING) return -1;
	if (position & DOCUMENT_POSITION_PRECEDING) return 1;
	return 0;
}

/** The node's document, whose selection reports one text node's offsets as selected. */
function selectionOver(node: Node, start: number, end: number, text: string, opts: { collapsed?: boolean; rect?: typeof RECT } = {}) {
	const range = {
		commonAncestorContainer: node,
		startContainer: node,
		startOffset: start,
		endContainer: node,
		endOffset: end,
		getBoundingClientRect: () => opts.rect ?? RECT,
		comparePoint(point: Node, offset: number): number {
			if (compareBoundary(point, offset, node, start) < 0) return -1;
			if (compareBoundary(point, offset, node, end) > 0) return 1;
			return 0;
		},
	};
	const selection = {
		isCollapsed: opts.collapsed ?? false,
		rangeCount: 1,
		getRangeAt: () => range,
		toString: () => text,
	};
	// currentMark takes the document: the node's own document, with its selection stood in.
	const doc = node.ownerDocument as unknown as { getSelection: () => unknown };
	doc.getSelection = () => selection;
	return doc as unknown as Document;
}

/** The first text node under the element matching the selector. */
function textNodeIn(doc: Document, selector: string): Node {
	const el = doc.querySelector(selector);
	assert.ok(el, `found ${selector}`);
	const text = Array.from(el!.childNodes).find((n) => n.nodeType === 3);
	assert.ok(text, "a text node");
	return text!;
}

describe("currentMark — what the Ask button may offer", () => {
	it("null for a collapsed selection", () => {
		const doc = docWith('<div class="lh-source-passage" data-source-message-id="m1"><p id="p">A passage</p></div>');
		const node = textNodeIn(doc, "#p");
		const sel = selectionOver(node, 2, 2, "", { collapsed: true });
		assert.equal(currentMark(sel, WIN), null);
	});

	it("null inside a textarea", () => {
		const doc = docWith(
			'<div class="lh-source-passage" data-source-message-id="m1"><textarea id="t">typed words</textarea></div>',
		);
		const node = textNodeIn(doc, "#t");
		const sel = selectionOver(node, 0, 5, "typed");
		assert.equal(currentMark(sel, WIN), null);
	});

	it("null for a selection outside any lesson passage (the quiz dock)", () => {
		const doc = docWith(
			'<div class="lh-source-passage" data-source-message-id="m1"><p>A lesson passage</p></div>' +
				'<div data-dock-block=""><p id="q">Which planet is closest to the sun?</p></div>',
		);
		const node = textNodeIn(doc, "#q");
		const sel = selectionOver(node, 0, 5, "Which");
		assert.equal(currentMark(sel, WIN), null);
	});

	it("null for a passage element with no message id", () => {
		const doc = docWith('<div class="lh-source-passage"><p id="p">An orphan passage</p></div>');
		const node = textNodeIn(doc, "#p");
		const sel = selectionOver(node, 0, 2, "An");
		assert.equal(currentMark(sel, WIN), null);
	});

	it("a mark with the trimmed quote, anchored to its message, inside a passage", () => {
		const doc = docWith('<div class="lh-source-passage" data-source-message-id="m1"><p id="p">A passage here</p></div>');
		const node = textNodeIn(doc, "#p");
		const sel = selectionOver(node, 0, 9, "A passage");
		const mark = currentMark(sel, WIN);
		assert.ok(mark, "a mark is offered");
		assert.equal(mark!.quote, "A passage");
		assert.deepEqual(mark!.anchor, { messageId: "m1", text: "A passage", occurrence: 0 });
		// with a mouse the button sits above the selection
		assert.equal(mark!.y, RECT.top - 42);
	});

	it("a mark inside a question's wording carries the call it belongs to (owner, 2026-11-06)", () => {
		const doc = docWith(
			'<div class="lh-source-passage" data-source-message-id="m1" data-source-call-id="call-1"><p id="q">Which planet is closest to the sun?</p></div>',
		);
		const node = textNodeIn(doc, "#q");
		const mark = currentMark(selectionOver(node, 16, 34, "closest to the sun"), WIN);
		assert.ok(mark, "the wording is markable");
		assert.deepEqual(mark!.anchor, { messageId: "m1", text: "closest to the sun", occurrence: 0, callId: "call-1" });
	});

	it("the occurrence of a phrase in a question's wording is counted among that question's passages only, not the lesson's", () => {
		const doc = docWith(
			'<div class="lh-source-passage" data-source-message-id="m1"><p>The rule is simple.</p></div>' +
				'<div class="lh-source-passage" data-source-message-id="m1" data-source-call-id="call-1"><p id="q">State the rule.</p></div>',
		);
		const node = textNodeIn(doc, "#q");
		const mark = currentMark(selectionOver(node, 10, 14, "rule"), WIN);
		assert.ok(mark);
		assert.deepEqual(mark!.anchor, { messageId: "m1", text: "rule", occurrence: 0, callId: "call-1" });
	});

	it("null for an option beside the wording: only the stem and context are passages", () => {
		const doc = docWith(
			'<div class="lh-source-passage" data-source-message-id="m1" data-source-call-id="call-1"><p>Which planet?</p></div>' +
				'<div role="radiogroup"><button id="o" type="button">Mercury</button></div>',
		);
		const node = textNodeIn(doc, "#o");
		assert.equal(currentMark(selectionOver(node, 0, 4, "Merc"), WIN), null);
	});

	it("the anchor's occurrence is the match the selection starts on", () => {
		// "rule" occurs at offsets 4 and 17; the learner marks the second one.
		const doc = docWith('<div class="lh-source-passage" data-source-message-id="m1"><p id="p">The rule and the rule.</p></div>');
		const node = textNodeIn(doc, "#p");
		const sel = selectionOver(node, 17, 21, "rule");
		const mark = currentMark(sel, WIN);
		assert.ok(mark, "a mark is offered");
		assert.equal(mark!.quote, "rule");
		assert.deepEqual(mark!.anchor, { messageId: "m1", text: "rule", occurrence: 1 });
	});
});

describe("the Ask offer beside the shared selection toolbar", () => {
	it("the floating button stays out of a region the toolbar already serves", () => {
		const doc = docWith('<div id="transcript"><div class="lh-source-passage" data-source-message-id="m1"><p id="p">A lesson passage</p></div></div>');
		const sel = selectionOver(textNodeIn(doc, "#p"), 2, 8, "lesson");
		assert.ok(currentMark(sel, WIN), "offered with no exclusion");
		assert.equal(currentMark(sel, WIN, doc.querySelector("#transcript")), null, "the toolbar's Ask serves it instead");
	});

	it("outside that region (the dock's wording) the floating button still offers", () => {
		const doc = docWith(
			'<div id="transcript"><p>Lesson</p></div><div class="lh-source-passage" data-source-message-id="q1"><p id="q">Which planet?</p></div>',
		);
		const sel = selectionOver(textNodeIn(doc, "#q"), 0, 5, "Which");
		assert.ok(currentMark(sel, WIN, doc.querySelector("#transcript")));
	});

	it("createAskAction is the third toolbar action: visible on a passage, and it hands the same mark over", async () => {
		const { createAskAction } = await import("../components/ask-selection.tsx");
		const doc = docWith('<div class="lh-source-passage" data-source-message-id="m1"><p id="p">The rule and the rule.</p></div>');
		const sel = selectionOver(textNodeIn(doc, "#p"), 17, 21, "rule");
		const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
		Object.defineProperty(globalThis, "document", { configurable: true, value: sel });
		try {
			const marks: unknown[] = [];
			const action = createAskAction({ onAsk: (m) => marks.push(m) });
			assert.equal(action.id, "ask");
			assert.equal(action.visible({} as never), true);
			assert.equal(action.onSelect({} as never), true);
			assert.deepEqual(marks, [{ quote: "rule", anchor: { messageId: "m1", text: "rule", occurrence: 1 } }]);
		} finally {
			if (previous) Object.defineProperty(globalThis, "document", previous);
			else delete (globalThis as Record<string, unknown>).document;
		}
	});
});
