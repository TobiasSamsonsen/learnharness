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
		removeItem(k: string) {
			this.store.delete(k);
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
const { readInk, writeInk, inkFromStrokes, readKept, writeKept, applyOp, revertOp, pagePayload } = await import("../components/sketch/ink-memory.ts");
const { clampBoxPosition } = await import("../components/sketch/floating-problem.tsx");
const pen = await import("../components/sketch/pen-settings.ts");
const { handleBack } = await import("../components/back-layers.ts");
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

async function mount(props: { inkKey: string; onSubmit: (s: SketchPayload, confidenceIndex?: number) => Promise<boolean>; onClose?: () => void; extra?: Record<string, unknown> }) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(<SketchView label="Problem" statement="Draw it." inkKey={props.inkKey} onSubmit={props.onSubmit} onClose={props.onClose ?? (() => {})} {...props.extra} />),
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
		writeInk("k-refused", inkFromStrokes([STROKE]));
		await mount({ inkKey: "k-refused", onSubmit: async () => false });
		await key({ key: "Enter", ctrlKey: true });
		await settle();
		assert.equal(readInk("k-refused").strokes.length, 1, "a 409/500/400 keeps the drawing for a retry");

		await act(async () => root!.unmount());
		writeInk("k-ok", inkFromStrokes([STROKE]));
		let sent: SketchPayload | null = null;
		await mount({ inkKey: "k-ok", onSubmit: async (s) => ((sent = s), true) });
		await key({ key: "Enter", ctrlKey: true });
		await settle();
		assert.equal(sent!.strokes.length, 1);
		assert.equal(readInk("k-ok").strokes.length, 0, "accepted → cleared");
	});

	it("ink drawn while the send was in flight survives it", async () => {
		writeInk("k-race", inkFromStrokes([STROKE]));
		let accept!: (ok: boolean) => void;
		await mount({ inkKey: "k-race", onSubmit: () => new Promise((r) => (accept = r)) });
		await key({ key: "Enter", ctrlKey: true });
		writeInk("k-race", inkFromStrokes([STROKE, { ...STROKE }])); // reopened and drew more
		await act(async () => accept(true));
		assert.equal(readInk("k-race").strokes.length, 1, "only what was drawn after the send stays unsent");
		assert.equal(readKept("k-race")?.strokes.length, 1, "what went out is the kept page");
	});

	it("plain Enter does nothing; Esc closes; Ctrl+Z / Ctrl+Shift+Z undo and redo", async () => {
		writeInk("k-keys", inkFromStrokes([STROKE, { ...STROKE }]));
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

describe("the back stack (Android plan M8)", () => {
	it("the view is a back layer: handleBack closes it like Esc, and an unmounted view leaves none", async () => {
		writeInk("k-back", inkFromStrokes([STROKE]));
		let closed = 0;
		await mount({ inkKey: "k-back", onSubmit: async () => true, onClose: () => closed++ });
		assert.equal(handleBack(), true);
		assert.equal(closed, 1);
		await act(async () => root!.unmount());
		assert.equal(handleBack(), false, "an unmounted view leaves no back layer behind");
	});
});

describe("the kept page (Android plan M3)", () => {
	it("a whole-page submit sends kept + new strokes, brackets from the new ink, and keeps the page", async () => {
		const old = { ...STROKE };
		writeKept("k-page", { id: "sk_oldoldold0000001", strokes: [old] });
		writeInk("k-page", inkFromStrokes([{ ...STROKE }]));
		let sent: SketchPayload | null = null;
		await mount({ inkKey: "k-page", onSubmit: async (s) => ((sent = s), true) });
		await key({ key: "Enter", ctrlKey: true });
		await settle();
		assert.equal(sent!.strokes.length, 2);
		assert.equal(sent!.newFrom, 1, "the new ink starts after the kept strokes");
		assert.equal(readKept("k-page")!.id, sent!.id, "the sent page is the kept page now");
		assert.equal(readKept("k-page")!.strokes.length, 2);
		assert.equal(readInk("k-page").strokes.length, 0);
	});

	it("an empty unsent layer submits nothing; a loading kept page blocks Submit", async () => {
		writeKept("k-empty", { id: "sk_oldoldold0000002", strokes: [STROKE] });
		let submits = 0;
		await mount({ inkKey: "k-empty", onSubmit: async () => (submits++, true) });
		await key({ key: "Enter", ctrlKey: true });
		assert.equal(submits, 0);
		await act(async () => root!.unmount());
		writeInk("k-load", inkFromStrokes([STROKE]));
		await mount({ inkKey: "k-load", onSubmit: async () => (submits++, true), extra: { keptStatus: "loading" } });
		await key({ key: "Enter", ctrlKey: true });
		assert.equal(submits, 0, "never send over a page that has not loaded");
	});

	it("erasing is one undoable step that restores strokes at their places", () => {
		const a = { ...STROKE }, b = { ...STROKE }, c = { ...STROKE }, d = { ...STROKE };
		const op = { kind: "erase" as const, removed: [{ index: 1, stroke: b }, { index: 2, stroke: c }] };
		const after = applyOp([a, b, c, d], op);
		assert.deepEqual(after, [a, d]);
		const back = revertOp(after, op);
		assert.equal(back[1], b);
		assert.equal(back[2], c);
		assert.equal(back.length, 4);
	});

	it("a submit blocked by the dock (no pick yet) sends nothing", async () => {
		writeInk("k-blocked", inkFromStrokes([STROKE]));
		let submits = 0;
		await mount({ inkKey: "k-blocked", onSubmit: async () => (submits++, true), extra: { blocked: "Pick an answer first" } });
		await key({ key: "Enter", ctrlKey: true });
		assert.equal(submits, 0);
		assert.match(document.body.textContent ?? "", /Pick an answer first/);
	});

	it("a quiz answer's Submit expands into the confidence buttons; the one pressed is sent with the sketch (owner, 2026-10-28)", async () => {
		writeInk("k-conf", inkFromStrokes([STROKE]));
		const sent: Array<number | undefined> = [];
		await mount({ inkKey: "k-conf", onSubmit: async (_s, idx) => (sent.push(idx), true), extra: { confidenceLevels: true } });
		const click = (id: string) => act(async () => (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).click());
		await click("sketch-submit");
		assert.deepEqual(sent, [], "the first press only asks");
		assert.ok(!document.querySelector('[data-testid="sketch-submit"]'), "Submit stands aside for the buttons");
		for (const label of ["Guess", "Unsure", "Likely", "Sure", "Certain"]) assert.match(document.body.textContent ?? "", new RegExp(label));
		await click("sketch-confidence-90");
		await settle();
		assert.deepEqual(sent, [4], "index 4 is the 90 stop");
	});

	it("without a quiz answer Submit sends at once", async () => {
		writeInk("k-noconf", inkFromStrokes([STROKE]));
		const sent: Array<number | undefined> = [];
		await mount({ inkKey: "k-noconf", onSubmit: async (_s, idx) => (sent.push(idx), true) });
		await act(async () => (document.querySelector('[data-testid="sketch-submit"]') as HTMLElement).click());
		await settle();
		assert.deepEqual(sent, [undefined]);
	});

	it("the page grows below the lowest ink and stops at the cap", async () => {
		const { sketchPageHeight, SKETCH_PAGE_MAX_HEIGHT } = await import("../components/sketch/sketch-canvas.tsx");
		assert.equal(sketchPageHeight(800, 100), 800);
		assert.equal(sketchPageHeight(800, 1000), 1480);
		assert.equal(sketchPageHeight(800, 99999), SKETCH_PAGE_MAX_HEIGHT);
	});

	it("pagePayload without a kept page has no bracket", () => {
		assert.equal(pagePayload(null, [STROKE]).newFrom, undefined);
	});
});

describe("MC answer controls in the box (Android plan M3)", () => {
	it("render the dock's options and I don't know, and call its handlers (the confidence is asked on Submit)", async () => {
		const { SketchChoices } = await import("../components/sketch/sketch-choices.tsx");
		const calls: string[] = [];
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root!.render(
				<SketchChoices
					kind="quiz"
					multi={false}
					options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]}
					sel={{ selected: new Set([1]), otherSelected: false, dontKnow: false }}
					onToggle={(i) => calls.push(`toggle${i}`)}
					onDontKnow={() => calls.push("idk")}
					onOther={() => calls.push("other")}
					other=""
					onOtherText={() => {}}
				/>,
			),
		);
		const click = (id: string) => act(async () => (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).click());
		assert.equal(document.querySelector('[data-testid="sketch-choice-1"]')?.getAttribute("aria-checked"), "true");
		assert.ok(!document.querySelector('[data-testid="sketch-confidence-70"]'), "no confidence stops in the box");
		await click("sketch-choice-0");
		await click("sketch-choice-dontknow");
		assert.deepEqual(calls, ["toggle0", "idk"]);
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

describe("pen and clear (M13b)", () => {
	const { loadPen, savePen, penStroke, DEFAULT_PEN, SKETCH_COLORS, SKETCH_WIDTHS } = pen;
	const click = (testid: string) =>
		act(async () => {
			document.querySelector(`[data-testid="${testid}"]`)!.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
		});

	it("the palette keeps clear of the margin bracket's magenta", () => {
		assert.equal(SKETCH_COLORS.length, 5);
		assert.equal(SKETCH_WIDTHS.length, 3);
		for (const c of SKETCH_COLORS) assert.notEqual(c.value, "#d946ef");
	});

	it("penStroke: default ink carries no colour, any other does", () => {
		assert.deepEqual(penStroke(DEFAULT_PEN, [1, 2, 0.5]), { size: 4, points: [1, 2, 0.5] });
		assert.deepEqual(penStroke({ color: "#dc2626", size: 8 }, [1, 2, 0.5]), { size: 8, color: "#dc2626", points: [1, 2, 0.5] });
	});

	it("the remembered pen survives a reload; unknown values fall back to the default", () => {
		savePen({ color: "#16a34a", size: 2 });
		assert.deepEqual(loadPen(), { color: "#16a34a", size: 2 });
		localStorage.setItem("lh:sketch-pen", JSON.stringify({ color: "#123456", size: 99 }));
		assert.deepEqual(loadPen(), DEFAULT_PEN);
		localStorage.setItem("lh:sketch-pen", "not json");
		assert.deepEqual(loadPen(), DEFAULT_PEN);
		localStorage.removeItem("lh:sketch-pen");
	});

	it("choosing a colour or width marks it pressed and is remembered", async () => {
		localStorage.removeItem("lh:sketch-pen");
		await mount({ inkKey: "k-pen", onSubmit: async () => true });
		const pressed = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getAttribute("aria-pressed");
		assert.equal(pressed("sketch-color-black"), "true");
		await click("sketch-color-red");
		await click("sketch-width-thick");
		assert.equal(pressed("sketch-color-red"), "true");
		assert.equal(pressed("sketch-color-black"), "false");
		assert.equal(pressed("sketch-width-thick"), "true");
		assert.deepEqual(loadPen(), { color: "#dc2626", size: 8 });
		localStorage.removeItem("lh:sketch-pen");
	});

	it("Clear is undoable (and redoable), and still leaves nothing to submit", async () => {
		writeInk("k-clear", inkFromStrokes([STROKE, { ...STROKE }]));
		await mount({ inkKey: "k-clear", onSubmit: async () => true });
		await click("sketch-clear");
		assert.equal(readInk("k-clear").strokes.length, 0);
		await click("sketch-undo");
		assert.equal(readInk("k-clear").strokes.length, 2, "undo brings every stroke back");
		await click("sketch-redo");
		assert.equal(readInk("k-clear").strokes.length, 0, "redo clears again");
	});

	it("applyOp / revertOp handle a cut over several strokes (one splits in two, one vanishes)", () => {
		const a: SketchStroke = { size: 4, points: [0, 0, 0.5, 10, 0, 0.5] };
		const b: SketchStroke = { size: 4, points: [0, 10, 0.5, 10, 10, 0.5] };
		const c: SketchStroke = { size: 4, points: [0, 20, 0.5, 10, 20, 0.5] };
		const d: SketchStroke = { size: 4, points: [0, 30, 0.5, 10, 30, 0.5] };
		const a1: SketchStroke = { size: 4, points: [0, 0, 0.5, 3, 0, 0.5] };
		const a2: SketchStroke = { size: 4, points: [7, 0, 0.5, 10, 0, 0.5] };
		const op = { kind: "cut" as const, changes: [{ index: 0, stroke: a, pieces: [a1, a2] }, { index: 2, stroke: c, pieces: [] }] };
		const before = [a, b, c, d];
		const after = applyOp(before, op);
		assert.deepEqual(after, [a1, a2, b, d]);
		assert.deepEqual(revertOp(after, op), before, "undo restores the strokes in their places");
	});

	it("applyOp / revertOp handle a clear", () => {
		const op = { kind: "clear" as const, removed: [STROKE, { ...STROKE }] };
		assert.deepEqual(applyOp([STROKE, op.removed[1]!], op), []);
		assert.equal(revertOp([], op).length, 2);
	});
});
