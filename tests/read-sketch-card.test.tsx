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

async function mount(opts: { part?: Record<string, unknown>; dispute?: Dispute; newest?: boolean; sent?: Array<[string, string | undefined]>; noContext?: boolean }) {
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
					isNewest: () => opts.newest ?? false,
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
	it("shows the sketch, the reading folded under \"I read\", and the doubts always", async () => {
		await mount({ part: { input: { sketchId: SK, reading: "$x^2 + 1$", uncertain: ["the exponent could be 3", "  "] } } });
		const html = host!.innerHTML;
		assert.match(el("read-sketch-toggle").textContent ?? "", /I read/);
		assert.match(html, /\/api\/chats\/chat_c\/sketches\/sk_cardtest0000001\/0/, "the thumbnail");
		assert.ok(!has("read-sketch-reading"), "the transcription is folded away");
		assert.equal(el("read-sketch-toggle").getAttribute("aria-expanded"), "false");
		await act(async () => el("read-sketch-toggle").click());
		assert.ok(has("read-sketch-reading"), "the dropdown opens it");
		assert.equal(el("read-sketch-toggle").getAttribute("aria-expanded"), "true");
		await act(async () => el("read-sketch-toggle").click());
		assert.ok(!has("read-sketch-reading"), "and closes it again");
		assert.match(el("read-sketch-doubts").textContent ?? "", /the exponent could be 3/);
		assert.equal(el("read-sketch-doubts").querySelectorAll("li").length, 1, "blank doubts are dropped");
	});

	it("turns red and asks for the clarification while the newest reading has open doubts", async () => {
		const doubtful = { input: { sketchId: SK, reading: "$-5$", uncertain: ["the bottom-left entry: -5 or 5 crossed out"] } };
		await mount({ part: doubtful, newest: true });
		assert.equal(el("read-sketch-card").getAttribute("data-needs-clarification"), "true");
		assert.match(el("read-sketch-card").className, /border-destructive/);
		assert.match(el("read-sketch-doubts").textContent ?? "", /Needs your clarification:.*bottom-left entry/s);
		assert.match(el("read-sketch-doubts").className, /text-destructive/);
		assert.match(el("read-sketch-clarify").textContent ?? "", /Answer below to continue/);
		// An older reading's doubts are history, not a request.
		await act(async () => root!.unmount());
		await mount({ part: doubtful, newest: false });
		assert.equal(el("read-sketch-card").getAttribute("data-needs-clarification"), null);
		assert.ok(!has("read-sketch-clarify"));
		assert.match(el("read-sketch-doubts").textContent ?? "", /Not sure about:/);
		assert.ok(!/text-destructive/.test(el("read-sketch-doubts").className));
		// Not red before the call has its result, nor when only marks were settled.
		await act(async () => root!.unmount());
		await mount({ part: { ...doubtful, state: "input-available", output: undefined }, newest: true });
		assert.ok(!has("read-sketch-clarify"));
		await act(async () => root!.unmount());
		await mount({ part: { input: { sketchId: SK, reading: "$-5$", uncertain: [], settled: ["took -5"] } }, newest: true });
		assert.ok(!has("read-sketch-clarify") && el("read-sketch-card").getAttribute("data-needs-clarification") === null);
	});

	it("lists the marks the tutor settled, apart from the doubts", async () => {
		await mount({ part: { input: { sketchId: SK, reading: "$-5$", uncertain: [], settled: ["bottom-left entry: -5 or 5 crossed out; took -5"] } } });
		assert.match(el("read-sketch-settled").textContent ?? "", /Took these as:.*took -5/s);
		assert.ok(!has("read-sketch-doubts"), "nothing unresolved");
		await act(async () => root!.unmount());
		await mount({ part: { input: { sketchId: SK, reading: "$x$", uncertain: ["the exponent"] } } });
		assert.ok(!has("read-sketch-settled") && has("read-sketch-doubts"));
	});

	it("heals the raw arguments the record keeps (leaked parameter markup)", async () => {
		await mount({ part: { input: { sketchId: `${SK}</parameter>
<parameter name="reading">Z then x</parameter>`, uncertain: ["the first glyph"] } } });
		assert.ok(has("read-sketch-card"), "the reading was in the wrong field, not lost");
		await act(async () => el("read-sketch-toggle").click());
		assert.match(el("read-sketch-reading").textContent ?? "", /Z then x/);
		assert.match(host!.innerHTML, /sketches\/sk_cardtest0000001\/0/, "and the id is the clean one");
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
