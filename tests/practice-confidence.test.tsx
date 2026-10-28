import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { PracticeDock, type ThinkingMark } from "../components/practice-dock.tsx";

// Confidence in Practice (owner, 2026-10-28): Submit thinking expands into the five confidence buttons, and the pressed one
// (or "I don't know") rides the submission.

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	ResizeObserver: class { observe() {} disconnect() {} } });

// React's IE fallback (no `oninput` in linkedom) wants these
Object.assign(dom.window.HTMLTextAreaElement.prototype, { attachEvent() {}, detachEvent() {} });

let host: HTMLElement;
let root: Root;
let sent: Array<{ text: string; mark?: ThinkingMark }>;

beforeEach(async () => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	sent = [];
	await act(async () => root.render(<PracticeDock problemCallId="p1" chatId="c1" input={{ statement: "Find the order." }} expanded
		onExpand={() => {}} onSubmit={(text, _sketch, _ref, mark) => { sent.push({ text, mark }); }} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const el = (testid: string) => host.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
const type = async (text: string) => {
	const field = host.querySelector<HTMLTextAreaElement>("textarea")!;
	// linkedom has no `oninput`, so React falls back to its IE path: watch on focusin, read the value on keyup
	await act(async () => {
		field.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
		Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
		field.dispatchEvent(new dom.window.Event("keyup", { bubbles: true }));
	});
};

test("Submit thinking waits for text, then expands into the confidence buttons; a press sends with that confidence", async () => {
	assert.equal((el("practice-send") as HTMLButtonElement).disabled, true);
	await type("it divides p");
	await act(async () => el("practice-send")!.click());
	assert.deepEqual(sent, [], "the first press only asks");
	assert.equal(el("practice-send"), null, "Submit stands aside for the buttons");
	for (const label of ["Guess", "Unsure", "Likely", "Sure", "Certain"]) assert.match(host.textContent ?? "", new RegExp(label));
	await act(async () => el("practice-confidence-70")!.click());
	assert.deepEqual(sent, [{ text: "it divides p", mark: { confidence: 70 } }]);
});

test("I don't know sends the text with no confidence and the flag", async () => {
	await type("no idea");
	await act(async () => el("practice-send")!.click());
	await act(async () => el("practice-dont-know")!.click());
	assert.deepEqual(sent, [{ text: "no idea", mark: { dontKnow: true } }]);
});

test("editing the text puts Submit back", async () => {
	await type("first");
	await act(async () => el("practice-send")!.click());
	assert.ok(el("practice-confidence-row"));
	await type("first, and more");
	assert.equal(el("practice-confidence-row"), null);
	assert.ok(el("practice-send"));
});
