import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

/**
 * The model and its effort are ONE control (owner, 2026-10-27: two pills took three lines under the chat box on a
 * phone): the pill reads "model · effort", and the effort is changed inside the model popup.
 */

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	Node: dom.window.Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	ResizeObserver: class {
		observe() {}
		disconnect() {}
	},
	requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) as unknown as number,
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
(dom.window.HTMLElement.prototype as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({
	x: 0, y: 600, width: 200, height: 40, left: 0, top: 600, right: 200, bottom: 640,
});

const { ModelControl } = await import("../components/model-picker.tsx");

const MODEL = { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "claude-code", reasoning: true, input: ["text"], supportedLevels: ["low", "medium", "high"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000 };
const puts: unknown[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
	const url = String(input);
	if (url === "/api/models") return Response.json({ models: [MODEL], providers: [], slots: {}, defaults: {} });
	if (url === "/api/settings") return Response.json({ settings: { models: { strong: { model: { provider: "claude-code", id: "claude-sonnet-5" }, thinkingLevel: "medium" } } } });
	if (url === "/api/settings/models" && init?.method === "PUT") {
		const body = JSON.parse(init.body ?? "{}");
		puts.push(body);
		return Response.json({ settings: { models: body } });
	}
	throw new Error(`unexpected request ${url}`);
}) as typeof fetch;

let host: HTMLElement | undefined;
let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	puts.length = 0;
});
process.on("exit", () => {
	globalThis.fetch = originalFetch;
});

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)));

async function mount() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<ModelControl />));
	await settle();
}

describe("the model and effort pill", () => {
	it("is ONE pill reading 'model · effort', with no separate effort button", async () => {
		await mount();
		const pill = byId("stats-model")!;
		assert.ok(pill, "the model pill");
		const text = pill.textContent ?? "";
		assert.match(text, /claude-sonnet/);
		assert.match(text, /·/);
		assert.match(text, /medium/i);
		assert.equal(byId("stats-thinking"), null, "the effort is not a second control");
	});

	it("the popup carries the effort row; picking a level writes it with the same model", async () => {
		await mount();
		await act(async () => void byId("stats-model")!.click());
		await settle();
		assert.ok(byId("effort-row"), "effort row inside the model popup");
		for (const level of ["low", "medium", "high"]) assert.ok(byId(`thinking-option-${level}`), level);
		assert.equal(byId("thinking-option-medium")!.getAttribute("aria-pressed"), "true");
		await act(async () => void byId("thinking-option-high")!.click());
		await settle();
		assert.equal(puts.length, 1);
		const put = puts[0] as { strong: { model: { id: string }; thinkingLevel: string } };
		assert.equal(put.strong.model.id, "claude-sonnet-5");
		assert.equal(put.strong.thinkingLevel, "high");
	});
});
