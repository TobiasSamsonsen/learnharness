import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

/**
 * The sketch view with the Android shell's native ink layer (Android plan M10, docs/android/m10-plan.md): a fake
 * `window.lhAndroid` records what the page posts and plays the shell's lines back. The store keeps owning the strokes.
 */

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	},
	ResizeObserver: class {
		observe() {}
		disconnect() {}
	},
	requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) as unknown as number,
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
(dom.window.HTMLElement.prototype as unknown as { getContext: () => null }).getContext = () => null;
(dom.window.HTMLElement.prototype as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({
	x: 0,
	y: 100,
	width: 400,
	height: 600,
	left: 0,
	top: 100,
	right: 400,
	bottom: 700,
});

const { SketchView } = await import("../components/sketch/sketch-view.tsx");
const { readInk, writeInk, inkFromStrokes } = await import("../components/sketch/ink-memory.ts");
import type { SketchPayload, SketchStroke } from "../src/core";

const STROKE: SketchStroke = { size: 4, points: [10, 10, 0.5, 90, 50, 0.6, 200, 30, 0.5] };
const NATIVE_STROKE: SketchStroke = { size: 4, points: [20, 20, 0.5, 100, 60, 0.5] };

/** `window.lhAndroid`: records the page's posts, and `say` plays a line from the shell. */
function fakeShell() {
	const listeners = new Set<(e: { data: unknown }) => void>();
	const posted: string[] = [];
	(window as unknown as { lhAndroid: unknown }).lhAndroid = {
		postMessage: (m: string) => void posted.push(m),
		addEventListener: (_t: string, fn: (e: { data: unknown }) => void) => void listeners.add(fn),
		removeEventListener: (_t: string, fn: (e: { data: unknown }) => void) => void listeners.delete(fn),
	};
	return { posted, say: (line: string) => act(async () => void listeners.forEach((fn) => fn({ data: line }))), listeners };
}

let host: HTMLElement | undefined;
let root: Root | undefined;
beforeEach(() => store.clear());
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	delete (window as unknown as { lhAndroid?: unknown }).lhAndroid;
	document.documentElement.classList.remove("lh-native-ink");
});

async function mount(inkKey: string, onSubmit: (s: SketchPayload) => Promise<boolean> = async () => true) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<SketchView label="Problem" statement="Draw it." inkKey={inkKey} onSubmit={onSubmit} onClose={() => {}} />));
}
const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = (id: string) => act(async () => void byId(id)!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
const key = (init: { key: string; ctrlKey?: boolean }) =>
	act(async () => {
		window.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { ctrlKey: false, shiftKey: false, metaKey: false, ...init }));
	});

describe("the setting and the bridge decide", () => {
	it("the shell has the bridge and the setting was never touched: native ink is the default", async () => {
		const shell = fakeShell();
		await mount("k-default");
		assert.ok(byId("sketch-native-scroller"), "native by default");
		assert.equal(byId("sketch-canvas"), null);
		assert.ok(shell.posted.some((l) => l.startsWith("open k-default ")));
	});

	it("the learner turned it off: the web canvas, nothing posted", async () => {
		store.set("lh:native-ink", "off");
		const shell = fakeShell();
		await mount("k-off");
		assert.ok(byId("sketch-canvas"), "the web canvas");
		assert.equal(byId("sketch-native-scroller"), null);
		assert.deepEqual(shell.posted, []);
		assert.ok(!document.documentElement.classList.contains("lh-native-ink"));
	});

	it("no bridge (a plain browser): the web canvas, whatever the setting says", async () => {
		store.set("lh:native-ink", "on");
		await mount("k-nobridge");
		assert.ok(byId("sketch-canvas"));
	});
});

describe("native ink is on", () => {
	beforeEach(() => store.set("lh:native-ink", "on"));

	it("opens the shell's layer on the canvas rectangle, reports the floating box as a hole, and sends the tool and the strokes", async () => {
		writeInk("k-open", inkFromStrokes([STROKE]));
		const shell = fakeShell();
		await mount("k-open");
		assert.ok(shell.posted.includes("open k-open 0 100 400 600"), shell.posted.join(" | "));
		assert.ok(shell.posted.some((l) => l.startsWith("holes 0,100,400,600")), "the floating box is a hole");
		assert.ok(shell.posted.includes("tool pen"));
		assert.ok(shell.posted.includes("kept []"));
		assert.ok(shell.posted.includes(`strokes ${JSON.stringify([STROKE])}`), "the store's strokes go to the shell");
		assert.ok(byId("sketch-native-scroller"), "a transparent scroller instead of the canvas");
		assert.equal(byId("sketch-canvas"), null);
		assert.ok(document.documentElement.classList.contains("lh-native-ink"), "the page lets the ink through");
		assert.ok(byId("sketch-view")!.className.includes("bg-transparent"));
	});

	it("a stroke from the shell goes through the store (undo works) and is only acknowledged, not pushed back", async () => {
		const shell = fakeShell();
		await mount("k-stroke");
		await shell.say(`stroke ${JSON.stringify([NATIVE_STROKE])}`);
		assert.deepEqual(readInk("k-stroke").strokes, [NATIVE_STROKE]);
		assert.ok(shell.posted.includes("ack"), shell.posted.join(" | "));
		assert.ok(!shell.posted.includes(`strokes ${JSON.stringify([NATIVE_STROKE])}`), "no full push for a plain append");
		await click("sketch-undo");
		assert.deepEqual(readInk("k-stroke").strokes, []);
		assert.equal(shell.posted.at(-1), "strokes []", "an undo is pushed whole");
		await click("sketch-redo");
		assert.equal(shell.posted.at(-1), `strokes ${JSON.stringify([NATIVE_STROKE])}`, "so is a redo");
	});

	it("an eraser gesture from the shell removes the stroke it touched, as one undoable step", async () => {
		writeInk("k-erase", inkFromStrokes([STROKE, NATIVE_STROKE]));
		const shell = fakeShell();
		await mount("k-erase");
		await shell.say("erase 200,30,201,30"); // on the end of STROKE
		assert.deepEqual(readInk("k-erase").strokes, [NATIVE_STROKE]);
		assert.equal(shell.posted.at(-1), `strokes ${JSON.stringify([NATIVE_STROKE])}`);
		await click("sketch-undo");
		assert.equal(readInk("k-erase").strokes.length, 2, "the erase is one step");
		await shell.say("erase 900,900"); // touches nothing
		assert.equal(readInk("k-erase").strokes.length, 2);
	});

	it("two-finger pans scroll the transparent scroller, and its scroll is reported", async () => {
		const shell = fakeShell();
		await mount("k-pan");
		const scroller = byId("sketch-native-scroller")!;
		(scroller as unknown as { scrollTop: number }).scrollTop = 0;
		await shell.say("pan 40");
		assert.equal((scroller as unknown as { scrollTop: number }).scrollTop, 40);
		scroller.dispatchEvent(new dom.window.Event("scroll"));
		await act(async () => await new Promise((r) => setTimeout(r, 5)));
		assert.ok(shell.posted.includes("scroll 40"), shell.posted.join(" | "));
	});

	it("the toolbar's tool follows to the shell", async () => {
		const shell = fakeShell();
		await mount("k-tool");
		await click("sketch-eraser");
		assert.equal(shell.posted.at(-1), "tool eraser");
	});

	it("the shell reports the layer cannot be shown: the web canvas takes over, once, with a note", async () => {
		writeInk("k-fallback", inkFromStrokes([STROKE]));
		const shell = fakeShell();
		await mount("k-fallback");
		await shell.say("fallback no surface");
		assert.ok(byId("sketch-canvas"), "the web canvas is back");
		assert.equal(byId("sketch-native-scroller"), null);
		assert.equal(shell.posted.at(-1), "close", "the shell is told to close the layer");
		assert.ok(!document.documentElement.classList.contains("lh-native-ink"));
		assert.match(document.body.textContent ?? "", /native ink unavailable \(no surface\)/);
		assert.deepEqual(readInk("k-fallback").strokes, [STROKE], "the ink is untouched");
	});

	it("closing the sketch closes the layer", async () => {
		const shell = fakeShell();
		await mount("k-close");
		await act(async () => root!.unmount());
		assert.equal(shell.posted.at(-1), "close");
		assert.equal(shell.listeners.size, 0, "the listener is gone");
		assert.ok(!document.documentElement.classList.contains("lh-native-ink"));
		root = createRoot(host!);
	});

	it("a native sketch is submitted as producer android-ink", async () => {
		writeInk("k-submit", inkFromStrokes([STROKE]));
		fakeShell();
		let sent: SketchPayload | undefined;
		await mount("k-submit", async (s) => {
			sent = s;
			return true;
		});
		await key({ key: "Enter", ctrlKey: true });
		assert.equal(sent?.producer, "android-ink");
	});
});
