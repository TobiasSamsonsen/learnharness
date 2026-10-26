import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

/**
 * The read-back card (Android plan M2, owner wording "I read:"): what it
 * shows from the call's own arguments, and when the dispute button exists
 * and what it sends.
 */

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: { getItem: () => null, setItem() {} },
});

const { ReadSketchCard, SketchDisputeLine } = await import("../components/artifacts/read-sketch-card.tsx");
const { ChatActionsContext } = await import("../components/chat.tsx");

type Dispute = "available" | "disputed" | "none";
const SK = "sk_cardtest0000001";

let host: HTMLElement | undefined;
let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
});

function part(over: Record<string, unknown> = {}) {
	return {
		type: "tool-read_sketch",
		state: "output-available",
		toolCallId: "call_r1",
		input: { sketchId: SK, reading: "$x^2 + 1$", uncertain: [] },
		output: "Reading recorded.",
		...over,
	};
}

async function mount(opts: { part?: Record<string, unknown>; dispute?: Dispute; sent?: Array<[string, string | undefined]>; noContext?: boolean }) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const sent = opts.sent ?? [];
	const value = opts.noContext
		? null
		: {
				chatId: "chat_c",
				syncFromServer: async () => {},
				sendText: () => {},
				openSetup: () => {},
				sketchDispute: {
					state: () => opts.dispute ?? "none",
					send: (id: string, text?: string) => void sent.push([id, text]),
				},
			};
	await act(async () =>
		root!.render(
			<ChatActionsContext.Provider value={value}>
				<ReadSketchCard part={part(opts.part) as never} />
			</ChatActionsContext.Provider>,
		),
	);
}
const has = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) !== null;
const el = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) as HTMLElement;

describe("ReadSketchCard", () => {
	it("shows the sketch, the reading under \"I read:\", and the doubts", async () => {
		await mount({ part: { input: { sketchId: SK, reading: "$x^2 + 1$", uncertain: ["the exponent could be 3", "  "] } } });
		const html = host!.innerHTML;
		assert.match(html, /I read:/);
		assert.match(html, /\/api\/chats\/chat_c\/sketches\/sk_cardtest0000001\/0/, "the thumbnail");
		assert.ok(has("read-sketch-reading"));
		assert.match(el("read-sketch-doubts").textContent ?? "", /the exponent could be 3/);
		assert.equal(el("read-sketch-doubts").querySelectorAll("li").length, 1, "blank doubts are dropped");
	});

	it("renders nothing without an id or a reading, and no thumbnail without a chat", async () => {
		await mount({ part: { input: { sketchId: SK } } });
		assert.ok(!has("read-sketch-card"));
		await act(async () => root!.unmount());
		await mount({ noContext: true });
		assert.ok(has("read-sketch-card") && !has("sketch-thumbnail"));
	});

	it("the dispute button exists only when the chat says it can", async () => {
		await mount({ dispute: "none" });
		assert.ok(!has("read-sketch-dispute"));
		await act(async () => root!.unmount());
		await mount({ dispute: "available", part: { state: "input-available", output: undefined } });
		assert.ok(!has("read-sketch-dispute"), "not before the call has a result");
		await act(async () => root!.unmount());
		await mount({ dispute: "disputed" });
		assert.ok(!has("read-sketch-dispute") && has("read-sketch-disputed"), "a note once disputed");
		await act(async () => root!.unmount());
		await mount({ dispute: "available" });
		assert.ok(has("read-sketch-dispute"));
		assert.match(el("read-sketch-dispute").textContent ?? "", /That's not what I wrote/);
	});

	it("sends the dispute with what the learner wrote — or without", async () => {
		const sent: Array<[string, string | undefined]> = [];
		await mount({ dispute: "available", sent });
		await act(async () => el("read-sketch-dispute").click());
		assert.ok(has("read-sketch-dispute-form") && !has("read-sketch-dispute"), "the field opens in place");
		const input = el("read-sketch-dispute-form").querySelector("input") as HTMLInputElement;
		input.value = "  x^3  ";
		await act(async () => {
			el("read-sketch-dispute-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		assert.deepEqual(sent, [[SK, "x^3"]]);
		assert.ok(!has("read-sketch-dispute-form"), "the field closes after sending");

		await act(async () => el("read-sketch-dispute").click());
		await act(async () => {
			el("read-sketch-dispute-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		assert.deepEqual(sent.at(-1), [SK, undefined], "the words are optional");
	});
});

describe("SketchDisputeLine", () => {
	it("says what the learner said, when they said it", async () => {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () => root!.render(<SketchDisputeLine data={{ sketchId: SK, text: "it was x^3" }} />));
		assert.match(host.textContent ?? "", /said the reading was wrong: it was x\^3/);
		await act(async () => root!.render(<SketchDisputeLine data={{ sketchId: SK }} />));
		assert.match(host.textContent ?? "", /said the reading was wrong\.$/);
	});
});
