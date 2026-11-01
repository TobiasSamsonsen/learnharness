import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { currentMark } from "../components/ask-selection.tsx";

// The DOM environment is linkedom, as in tests/session-find.test.tsx (the repo's
// only DOM seam). currentMark reads the document selection and the range's rect,
// so the selection is a small stand-in over real linkedom nodes: the scope and
// field checks run on the real elements.

const RECT = { top: 100, bottom: 120, left: 50, right: 150, width: 100, height: 20 };
const WIN = { innerWidth: 1000, matchMedia: () => ({ matches: false }) } as unknown as Window;

function docWith(html: string) {
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	return document as unknown as Document;
}

/** A selection over one node's text, reporting the given text as selected. */
function selectionOver(node: Node, text: string, opts: { collapsed?: boolean; rect?: typeof RECT } = {}) {
	const range = {
		commonAncestorContainer: node,
		getBoundingClientRect: () => opts.rect ?? RECT,
	};
	const selection = {
		isCollapsed: opts.collapsed ?? false,
		rangeCount: 1,
		getRangeAt: () => range,
		toString: () => text,
	};
	return {
		getSelection: () => selection,
	} as unknown as Document;
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
		const doc = docWith('<div data-session-find-root><p id="p">A passage</p></div>');
		const node = textNodeIn(doc, "#p");
		const sel = selectionOver(node, "", { collapsed: true });
		assert.equal(currentMark(sel, WIN), null);
	});

	it("null for a selection outside an element carrying data-session-find-root", () => {
		const doc = docWith('<div><p id="p">A passage outside any scope</p></div>');
		const node = textNodeIn(doc, "#p");
		const sel = selectionOver(node, "A passage outside any scope");
		assert.equal(currentMark(sel, WIN), null);
	});

	it("null inside a textarea", () => {
		const doc = docWith('<div data-session-find-root><textarea id="t">typed words</textarea></div>');
		const node = textNodeIn(doc, "#t");
		const sel = selectionOver(node, "typed words");
		assert.equal(currentMark(sel, WIN), null);
	});

	it("a mark with the trimmed quote inside a scope", () => {
		const doc = docWith('<div data-session-find-root><p id="p">A passage here</p></div>');
		const node = textNodeIn(doc, "#p");
		const sel = selectionOver(node, "  A passage here \n");
		const mark = currentMark(sel, WIN);
		assert.ok(mark, "a mark is offered");
		assert.equal(mark!.quote, "A passage here");
		// with a mouse the button sits above the selection
		assert.equal(mark!.y, RECT.top - 42);
	});
});
