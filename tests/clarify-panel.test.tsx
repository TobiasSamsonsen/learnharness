import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ClarifyPanel, type ClarifyPanelProps } from "../components/clarify-panel.tsx";
import type { Clarification } from "../src/core/contracts/chat.ts";

// The Ask area's static render (the reading-thinking-field technique). Typing
// and focus are browser behavior; here the send button's disabled rule is read
// off the rendered markup, and the field's typed-text path is left to the browser.

const ENTRY: Clarification = {
	id: "c1",
	quote: "the inner planets",
	question: "what does inner mean?",
	reply: "Inner means the planets nearest the sun.",
	at: "2026-11-01T00:00:00.000Z",
};

function render(overrides: Partial<ClarifyPanelProps> = {}): string {
	const props: ClarifyPanelProps = {
		thread: [],
		busy: false,
		error: null,
		quote: null,
		onClearQuote: () => {},
		onAsk: async () => true,
		...overrides,
	};
	return renderToStaticMarkup(<ClarifyPanel {...props} />);
}

/** The opening tag of the send button, or null when it is not rendered. */
function sendButtonTag(html: string): string | null {
	return html.match(/<button[^>]*data-testid="clarify-send"[^>]*>/)?.[0] ?? null;
}

describe("ClarifyPanel — when it shows", () => {
	it("renders nothing when the thread is empty, nothing is marked, and nothing is busy or failed", () => {
		assert.equal(render(), "");
	});

	it("shows when the thread has entries", () => {
		assert.notEqual(render({ thread: [ENTRY] }), "");
	});

	it("shows when a quote is marked", () => {
		assert.notEqual(render({ quote: "marked" }), "");
	});

	it("shows when busy or when there is an error", () => {
		assert.notEqual(render({ busy: true }), "");
		assert.notEqual(render({ error: "nope" }), "");
	});
});

describe("ClarifyPanel — the thread", () => {
	it("shows the quote, the question and the reply of each earlier pair", () => {
		const html = render({ thread: [ENTRY] });
		assert.ok(html.includes('data-testid="clarify-thread"'), "the thread list is rendered");
		assert.ok(html.includes("the inner planets"), "the quote");
		assert.ok(html.includes("what does inner mean?"), "the question");
		assert.ok(html.includes("Inner means the planets nearest the sun."), "the reply");
	});
});

describe("ClarifyPanel — the marked quote and the field", () => {
	it("shows the marked quote and the field when quote is set", () => {
		const html = render({ quote: "the marked passage" });
		assert.ok(html.includes('data-testid="clarify-quote"'), "the quote block");
		assert.ok(html.includes("the marked passage"), "the quote text");
		assert.ok(html.includes('data-testid="clarify-field"'), "the question field");
		assert.ok(html.includes('aria-label="Clear the marked text"'), "the clear control");
	});

	it("shows no field when nothing is marked", () => {
		const html = render({ thread: [ENTRY] });
		assert.equal(html.includes('data-testid="clarify-field"'), false);
	});

	it("the send button is disabled while the question is blank (the initial state)", () => {
		const tag = sendButtonTag(render({ quote: "marked" }));
		assert.ok(tag, "the send button is rendered with a quote");
		assert.ok(/\sdisabled(=""|\s|>)/.test(tag), "disabled while the field is blank");
	});

	it("the send button is disabled while busy, even with a quote", () => {
		const tag = sendButtonTag(render({ quote: "marked", busy: true }));
		assert.ok(tag, "the send button is rendered");
		assert.ok(/\sdisabled(=""|\s|>)/.test(tag), "disabled while busy");
	});
});

describe("ClarifyPanel — busy and error", () => {
	it("shows the busy status", () => {
		const html = render({ busy: true });
		assert.ok(html.includes('data-testid="clarify-busy"'));
		assert.ok(html.includes('role="status"'));
		assert.ok(html.includes("The tutor is answering"));
	});

	it("shows the error as an alert", () => {
		const html = render({ error: "The tutor could not answer just now. Try again." });
		assert.ok(html.includes('data-testid="clarify-error"'));
		assert.ok(html.includes('role="alert"'));
		assert.ok(html.includes("The tutor could not answer just now. Try again."));
	});

	it("shows no busy status or error when neither is set", () => {
		const html = render({ thread: [ENTRY] });
		assert.equal(html.includes('data-testid="clarify-busy"'), false);
		assert.equal(html.includes('data-testid="clarify-error"'), false);
	});
});
