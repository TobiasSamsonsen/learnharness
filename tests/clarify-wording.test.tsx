import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ClarifyDockContext, ClarifyWording } from "../components/clarify-wording.tsx";
import type { ClarifyLayerProps } from "../components/clarify-layer.tsx";
import type { ClarifyThread } from "../src/core/contracts/chat.ts";

const thread = (callId: string | undefined): ClarifyThread => ({
	id: "t1",
	anchor: { messageId: "m1", text: "closest", occurrence: 0, ...(callId ? { callId } : {}) },
	quote: "closest",
	startedAt: "2026-11-06T10:00:00.000Z",
	entries: [],
});

const layerProps = (threads: ClarifyThread[]): ClarifyLayerProps => ({
	threads, busyKey: null, error: null, ask: async () => null, draft: null, onDraftDone: () => {},
});

describe("ClarifyWording — a question's wording as a markable passage", () => {
	it("marks the wording as a passage of its message and call", () => {
		const html = renderToStaticMarkup(<ClarifyWording messageId="m1" callId="c1"><p>Which planet?</p></ClarifyWording>);
		assert.match(html, /class="lh-source-passage"/);
		assert.match(html, /data-source-message-id="m1"/);
		assert.match(html, /data-source-call-id="c1"/);
		assert.ok(html.includes("Which planet?"));
	});

	it("without a message id or a call id it is plain content, not a passage", () => {
		for (const html of [
			renderToStaticMarkup(<ClarifyWording messageId={undefined} callId="c1"><p>Q</p></ClarifyWording>),
			renderToStaticMarkup(<ClarifyWording messageId="m1" callId={undefined}><p>Q</p></ClarifyWording>),
		]) {
			assert.equal(html.includes("lh-source-passage"), false);
			assert.ok(html.includes("<p>Q</p>"));
		}
	});

	it("in the dock with a provider: the margin layer sits beside the wording, with room only while this question has a thread", () => {
		const withThread = renderToStaticMarkup(
			<ClarifyDockContext.Provider value={layerProps([thread("c1")])}>
				<ClarifyWording messageId="m1" callId="c1" dock><p>Q</p></ClarifyWording>
			</ClarifyDockContext.Provider>,
		);
		assert.ok(withThread.includes('data-testid="clarify-layer"'), "the dock's own layer");
		assert.match(withThread, /class="relative pr-10"/);
		const noThread = renderToStaticMarkup(
			<ClarifyDockContext.Provider value={layerProps([thread("c2"), thread(undefined)])}>
				<ClarifyWording messageId="m1" callId="c1" dock><p>Q</p></ClarifyWording>
			</ClarifyDockContext.Provider>,
		);
		assert.ok(noThread.includes('data-testid="clarify-layer"'));
		assert.equal(noThread.includes("pr-10"), false, "another question's or a lesson thread reserves no room");
	});

	it("without a provider, or outside the dock, there is no layer (the transcript's own layer covers answered cards)", () => {
		assert.equal(renderToStaticMarkup(<ClarifyWording messageId="m1" callId="c1" dock><p>Q</p></ClarifyWording>).includes("clarify-layer"), false);
		const outside = renderToStaticMarkup(
			<ClarifyDockContext.Provider value={layerProps([thread("c1")])}>
				<ClarifyWording messageId="m1" callId="c1"><p>Q</p></ClarifyWording>
			</ClarifyDockContext.Provider>,
		);
		assert.equal(outside.includes("clarify-layer"), false);
	});
});
