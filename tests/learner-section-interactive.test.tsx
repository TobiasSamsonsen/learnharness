/**
 * Settings → Learner, interactive (fork addition, 2026-11-11): a DOM render
 * (linkedom, the chatgpt-connection UI test's setup) with fetch stubbed,
 * driving the note field, Adapt, draft editing and deleting, Apply and Remove.
 * Stands in for a browser check: it asserts what the section writes through
 * `onChange` (the dialog's replace-whole section PUT).
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { LearnerSection } from "../components/settings/learner-section.tsx";
import type { LearnerClaim, LearnerSettings } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
// linkedom has no `oninput`, so React would fall back to its IE input polyfill (which needs attachEvent): declare it
// before react-dom/client loads (React probes it once, at load), then import React DOM dynamically.
(dom.document as unknown as Record<string, unknown>).oninput = null;
const { createRoot } = await import("react-dom/client");
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	globalThis.fetch = originalFetch;
});

const claim = (over: Partial<LearnerClaim> = {}): LearnerClaim => ({ kind: "mistake", text: "Drops a sign", events: 4, chats: ["a", "b"], tentative: false, ...over });
const STATS = {
	fold: {
		classified: 6,
		missesShown: true,
		classes: [{ missClass: "execution", count: 6, sessions: 3, weight: 5, lastAt: 0, named: true }],
		calibration: { answers: 20, sessions: 2, dontKnow: 2, scored: 18, wrongHigh: 6, shown: true },
	},
	sessions: 5,
	adaptReady: true,
	adaptMinSessions: 3,
};
const DRAFT = { claims: [claim(), claim({ kind: "calibration", text: "Overconfident", events: 6, chats: ["c", "d"] }), claim({ kind: "pacing", text: "Slow start", events: 1, chats: ["a"], tentative: true })], gaps: ["No evidence about presentation style."], sessions: 5, truncated: false };

function stubFetch(handlers: { stats?: unknown; adapt?: { status: number; body: unknown } }) {
	const calls: string[] = [];
	globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
		const url = String(input);
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url === "/api/learner") return new Response(JSON.stringify(handlers.stats ?? STATS), { status: 200 });
		if (url === "/api/learner/adapt") return new Response(JSON.stringify(handlers.adapt?.body ?? DRAFT), { status: handlers.adapt?.status ?? 200 });
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
	return calls;
}

async function mount(learner: LearnerSettings | undefined) {
	const writes: LearnerSettings[] = [];
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<LearnerSection learner={learner} onChange={(next) => void writes.push(next)} />));
	await act(async () => {}); // the stats fetch settles
	return writes;
}

const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
async function click(el: HTMLElement) {
	assert.ok(el, "element to click");
	await act(async () => el.click());
}
async function type(el: HTMLElement, value: string) {
	await act(async () => {
		// The prototype's setter, not the node's: React tracks the node's own `value` and would see no change.
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
		el.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}
async function blur(el: HTMLElement) {
	await act(async () => el.dispatchEvent(new window.Event("focusout", { bubbles: true })));
}

describe("LearnerSection (DOM)", () => {
	it("loads the stats: the mistake classes, the calibration line, and Adapt enabled", async () => {
		const calls = stubFetch({});
		await mount(undefined);
		assert.deepEqual(calls, ["GET /api/learner"]);
		assert.match(byTest("learner-misses").textContent ?? "", /execution6 misses · 3 sessions · shown to the tutor/);
		assert.match(byTest("learner-calibration").textContent ?? "", /6 of 18 scored answers were wrong at a stated confidence of 90 or more; "I don't know" on 2\. Shown to the tutor\./);
		assert.equal((byTest("learner-adapt") as HTMLButtonElement).disabled, false);
		assert.equal(byTest("learner-adapt-needs"), null);
	});

	it("disables Adapt below three sessions and says how many there are", async () => {
		stubFetch({ stats: { ...STATS, sessions: 2, adaptReady: false } });
		await mount(undefined);
		assert.equal((byTest("learner-adapt") as HTMLButtonElement).disabled, true);
		assert.match(byTest("learner-adapt-needs").textContent ?? "", /Needs 3 sessions with evidence; you have 2\./);
	});

	it("commits the typed note on blur, keeping the applied claims", async () => {
		stubFetch({});
		const writes = await mount({ applied: [claim()] });
		const note = byTest("learner-note");
		await type(note, "  Worked examples first  ");
		assert.equal(writes.length, 0, "typing alone writes nothing");
		await blur(note);
		assert.deepEqual(writes, [{ note: "Worked examples first", applied: [claim()] }]);
	});

	it("clearing the note drops it from the section", async () => {
		stubFetch({});
		const writes = await mount({ note: "old" });
		await type(byTest("learner-note"), "   ");
		await blur(byTest("learner-note"));
		assert.deepEqual(writes, [{}]);
	});

	it("Adapt shows a draft; edit one claim, delete another, Apply writes the edited draft and the typed note", async () => {
		stubFetch({});
		const writes = await mount({ note: "stored note" });
		await click(byTest("learner-adapt"));
		assert.equal(all("learner-draft-claim").length, 3);
		assert.match(byTest("learner-draft").textContent ?? "", /Draft from 5 sessions\./);
		assert.match(byTest("learner-draft-gaps").textContent ?? "", /No evidence about presentation style\./);
		assert.match(all("learner-draft-claim")[2]!.textContent ?? "", /Pacing · 1 event in 1 chat · tentative/);

		await type(document.querySelector<HTMLElement>('textarea[aria-label="Claim 1"]')!, "Drops a sign when moving a term");
		await click(button("Delete", all("learner-draft-claim")[1]!));
		assert.equal(all("learner-draft-claim").length, 2);

		// The note is typed but the field is never blurred before Apply: Apply must carry the typed text.
		await type(byTest("learner-note"), "typed just before Apply");
		await click(byTest("learner-apply"));
		assert.equal(byTest("learner-draft"), null, "the draft closes");
		assert.deepEqual(writes, [{ note: "typed just before Apply", applied: [claim({ text: "Drops a sign when moving a term" }), claim({ kind: "pacing", text: "Slow start", events: 1, chats: ["a"], tentative: true })] }]);
	});

	it("Apply drops a claim whose text was cleared, and Discard writes nothing", async () => {
		stubFetch({});
		const writes = await mount(undefined);
		await click(byTest("learner-adapt"));
		await type(document.querySelector<HTMLElement>('textarea[aria-label="Claim 2"]')!, "   ");
		await click(byTest("learner-apply"));
		assert.equal(writes.length, 1);
		assert.deepEqual(writes[0]!.applied?.map((c) => c.text), ["Drops a sign", "Slow start"]);
		assert.equal(writes[0]!.note, undefined);

		await click(byTest("learner-adapt"));
		await click(button("Discard"));
		assert.equal(byTest("learner-draft"), null);
		assert.equal(writes.length, 1, "discard never writes");
	});

	it("an Adapt failure shows the message and leaves no draft", async () => {
		stubFetch({ adapt: { status: 503, body: { error: "No model is configured yet: pick the strong model in Settings first." } } });
		const writes = await mount(undefined);
		await click(byTest("learner-adapt"));
		assert.match(byTest("learner-adapt-error").textContent ?? "", /No model is configured yet/);
		assert.equal(byTest("learner-draft"), null);
		assert.equal(writes.length, 0);
	});

	it("Remove takes one applied claim out and keeps the note and the rest", async () => {
		stubFetch({});
		const writes = await mount({ note: "n", applied: [claim(), claim({ text: "second" })] });
		await click(document.querySelector<HTMLElement>('button[aria-label="Remove applied claim 1"]')!);
		assert.deepEqual(writes, [{ note: "n", applied: [claim({ text: "second" })] }]);
	});

	it("removing the last applied claim leaves just the note", async () => {
		stubFetch({});
		const writes = await mount({ note: "n", applied: [claim()] });
		await click(document.querySelector<HTMLElement>('button[aria-label="Remove applied claim 1"]')!);
		assert.deepEqual(writes, [{ note: "n" }]);
	});
});
