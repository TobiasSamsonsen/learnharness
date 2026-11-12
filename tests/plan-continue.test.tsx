/**
 * The Continue button under a standing plan (owner report, 2026-11-12): pressing it opened the abort-turn popup.
 *
 * The go-ahead makes the turn busy inside the click, and React reuses the Continue element for the submit button that
 * replaces it (now Stop). A browser finishes a click by activating the button as it is at that moment, so it submitted
 * the form, and a submit while busy with an empty draft is Stop. linkedom has no activation behaviour, so the fixture
 * does that step by hand: a click that was not cancelled on a submit button submits its form.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { Composer } from "../components/composer.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function fixture() {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	const selection = { anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, setBaseAndExtent() {} };
	Object.assign(doc, { getSelection: () => selection, oninput: null });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, innerWidth: 1000, innerHeight: 800,
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	const calls = { continue: 0, stop: 0, send: 0 };
	let busy = false;
	function draw() {
		root.render(
			<InteractionLayersProvider>
				<Composer
					busy={busy}
					value=""
					onChange={() => {}}
					onSend={() => { calls.send++; }}
					onStop={() => { calls.stop++; }}
					canSend={false}
					planContinue={!busy}
					// what chat.tsx's send does: the turn is busy before the click is over
					onPlanContinue={() => { calls.continue++; busy = true; draw(); }}
				/>
			</InteractionLayersProvider>,
		);
	}
	await act(async () => { draw(); });
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	/** A user's click, with the browser's own last step: an uncancelled click on a submit button submits the form. */
	const press = async (button: HTMLButtonElement) => {
		const click = new win.Event("click", { bubbles: true, cancelable: true });
		await act(async () => { button.dispatchEvent(click); });
		if (!click.defaultPrevented && button.isConnected && button.getAttribute("type") === "submit") {
			await act(async () => { button.closest("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); });
		}
		return click;
	};
	return { doc, calls, press };
}

describe("the plan's Continue button", () => {
	it("sends the go-ahead once and never reads as Stop, though the same element becomes the Stop button", async () => {
		const { doc, calls, press } = await fixture();
		const button = doc.querySelector<HTMLButtonElement>('[data-testid="plan-continue-button"]')!;
		assert.ok(button);
		assert.equal(button.getAttribute("type"), "button");

		const click = await press(button);

		assert.equal(calls.continue, 1);
		assert.equal(click.defaultPrevented, true, "the click is finished here: the browser must not go on to activate the button");
		assert.equal(calls.stop, 0, "no Stop, so no abort-turn popup");
		assert.equal(calls.send, 0);
		// why the cancel is needed: the pressed element is now the submit button, in its Stop state
		assert.equal(doc.querySelector('[data-testid="plan-continue-button"]'), null);
		assert.equal(button.isConnected, true);
		assert.equal(button.getAttribute("type"), "submit");
		assert.equal(button.getAttribute("aria-label"), "Stop");
	});

	it("Stop still stops: a later press of that button asks to abort", async () => {
		const { doc, calls, press } = await fixture();
		await press(doc.querySelector<HTMLButtonElement>('[data-testid="plan-continue-button"]')!);
		const stop = doc.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')!;
		await press(stop);
		assert.equal(calls.stop, 1);
		assert.equal(calls.continue, 1);
	});
});
