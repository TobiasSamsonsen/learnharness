import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

/**
 * The sketch view's interaction contract (Android plan M1 + the review
 * fixes, 2026-10-26): the keys, and the unsent-ink rule — the ink is
 * cleared only once the server accepted the sketch, and only if nothing
 * was drawn since.
 */

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: {
		store: new Map<string, string>(),
		getItem(k: string) {
			return this.store.get(k) ?? null;
		},
		setItem(k: string, v: string) {
			this.store.set(k, v);
		},
	},
	// The canvas needs a box observer and a 2D context; linkedom has neither.
	ResizeObserver: class {
		observe() {}
		disconnect() {}
	},
});
(dom.window.HTMLElement.prototype as unknown as { getContext: () => null }).getContext = () => null;

const { SketchView } = await import("../components/sketch/sketch-view.tsx");
const { readInk, writeInk } = await import("../components/sketch/ink-memory.ts");
const { clampBoxPosition } = await import("../components/sketch/floating-problem.tsx");
import type { SketchPayload, SketchStroke } from "../src/core";

const STROKE: SketchStroke = { size: 4, points: [10, 10, 0.5, 90, 50, 0.6, 200, 30, 0.5] };

let host: HTMLElement | undefined;
let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
});

async function mount(props: { inkKey: string; onSubmit: (s: SketchPayload) => Promise<boolean>; onClose?: () => void }) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(<SketchView label="Problem" statement="Draw it." inkKey={props.inkKey} onSubmit={props.onSubmit} onClose={props.onClose ?? (() => {})} />),
	);
}
const key = async (init: { key: string; ctrlKey?: boolean; shiftKey?: boolean }) =>
	act(async () => {
		// linkedom has no KeyboardEvent: a plain Event carrying the key fields.
		const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { ctrlKey: false, shiftKey: false, metaKey: false, ...init });
		window.dispatchEvent(event);
	});
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

describe("SketchView", () => {
	it("a refused send keeps the ink; an accepted one clears it", async () => {
		writeInk("k-refused", { strokes: [STROKE], redo: [] });
		await mount({ inkKey: "k-refused", onSubmit: async () => false });
		await key({ key: "Enter", ctrlKey: true });
		await settle();
		assert.equal(readInk("k-refused").strokes.length, 1, "a 409/500/400 keeps the drawing for a retry");

		await act(async () => root!.unmount());
		writeInk("k-ok", { strokes: [STROKE], redo: [] });
		let sent: SketchPayload | null = null;
		await mount({ inkKey: "k-ok", onSubmit: async (s) => ((sent = s), true) });
		await key({ key: "Enter", ctrlKey: true });
		await settle();
		assert.equal(sent!.strokes.length, 1);
		assert.equal(readInk("k-ok").strokes.length, 0, "accepted → cleared");
	});

	it("ink drawn while the send was in flight survives it", async () => {
		writeInk("k-race", { strokes: [STROKE], redo: [] });
		let accept!: (ok: boolean) => void;
		await mount({ inkKey: "k-race", onSubmit: () => new Promise((r) => (accept = r)) });
		await key({ key: "Enter", ctrlKey: true });
		writeInk("k-race", { strokes: [STROKE, STROKE], redo: [] }); // reopened and drew more
		await act(async () => accept(true));
		assert.equal(readInk("k-race").strokes.length, 2);
	});

	it("plain Enter does nothing; Esc closes; Ctrl+Z / Ctrl+Shift+Z undo and redo", async () => {
		writeInk("k-keys", { strokes: [STROKE, STROKE], redo: [] });
		let submits = 0;
		let closed = 0;
		await mount({ inkKey: "k-keys", onSubmit: async () => (submits++, true), onClose: () => closed++ });
		await key({ key: "Enter" });
		assert.equal(submits, 0);
		await key({ key: "z", ctrlKey: true });
		assert.equal(readInk("k-keys").strokes.length, 1);
		await key({ key: "z", ctrlKey: true, shiftKey: true });
		assert.equal(readInk("k-keys").strokes.length, 2);
		await key({ key: "Escape" });
		assert.equal(closed, 1);
	});
});

describe("the floating problem box", () => {
	const store = (globalThis as unknown as { localStorage: { store: Map<string, string> } }).localStorage.store;
	const click = (testid: string) =>
		act(async () => {
			(document.querySelector(`[data-testid="${testid}"]`) as HTMLElement).click();
		});
	const has = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) !== null;

	it("collapses to a pill and expands again; the state is remembered", async () => {
		store.clear();
		await mount({ inkKey: "k-box", onSubmit: async () => true });
		assert.ok(has("sketch-problem-box"), "starts expanded");
		assert.match(document.body.textContent ?? "", /Draw it\./);
		await click("sketch-problem-collapse");
		assert.ok(has("sketch-problem-pill") && !has("sketch-problem-box"), "a pill, not a bar");
		assert.ok(!(document.body.textContent ?? "").includes("Draw it."), "the statement is hidden");
		assert.equal((JSON.parse(store.get("lh:sketch-box")!) as { collapsed: boolean }).collapsed, true);

		// A fresh opening (a new mount) comes back collapsed.
		await act(async () => root!.unmount());
		await mount({ inkKey: "k-box", onSubmit: async () => true });
		assert.ok(has("sketch-problem-pill"), "remembered collapsed");
		await click("sketch-problem-pill");
		assert.ok(has("sketch-problem-box"), "a click on the pill expands it");
		assert.equal((JSON.parse(store.get("lh:sketch-box")!) as { collapsed: boolean }).collapsed, false);
	});

	it("keeps the box inside its parent, edges included", () => {
		const size = { width: 300, height: 120 };
		const bounds = { width: 1000, height: 600 };
		assert.deepEqual(clampBoxPosition(100, 50, size, bounds), { x: 100, y: 50 });
		assert.deepEqual(clampBoxPosition(-40, -9, size, bounds), { x: 4, y: 4 });
		assert.deepEqual(clampBoxPosition(900, 590, size, bounds), { x: 696, y: 476 });
		// Larger than its parent: pinned top-left, never negative.
		assert.deepEqual(clampBoxPosition(50, 50, { width: 2000, height: 900 }, bounds), { x: 4, y: 4 });
	});
});
