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
	requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) as unknown as number,
	cancelAnimationFrame: (id: number) => clearTimeout(id),
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
		await click("sketch-tool-pen"); // the active tool again opens its options
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
		await click("sketch-more");
		await click("sketch-clear");
		assert.equal(readInk("k-clear").strokes.length, 2, "Clear asks first: nothing is deleted yet");
		await click("sketch-clear-confirm");
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

	it("without a pen, a second finger turns a stroke into a pinch: the canvas zooms (and a finger stroke does not block it)", async () => {
		const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
		proto.setPointerCapture = () => {};
		proto.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, x: 0, y: 0 });
		await mount({ inkKey: "k-pinch", onSubmit: async () => true });
		const canvas = document.querySelector('[data-testid="sketch-canvas"]')!;
		const touch = (type: string, pointerId: number, x: number, y: number) =>
			act(async () => {
				canvas.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { pointerId, pointerType: "touch", clientX: x, clientY: y, button: 0, buttons: 1, pressure: 0.5 }));
			});
		const label = () => document.querySelector('[data-testid="sketch-zoom-level"]')!.textContent;
		await touch("pointerdown", 1, 100, 100); // the first finger starts a stroke
		await touch("pointerdown", 2, 200, 100); // the second finger: a pinch
		await touch("pointermove", 2, 300, 100); // spread from 100 to 200 apart
		assert.equal(label(), "200%");
		await touch("pointerup", 2, 300, 100);
		await touch("pointerup", 1, 100, 100);
		assert.equal(readInk("k-pinch").strokes.length, 0, "the stroke the first finger began was dropped");
	});

	it("the zoom is a number at the bottom with nothing to press (owner: pinch to zoom is enough)", async () => {
		await mount({ inkKey: "k-zoom", onSubmit: async () => true });
		const level = () => document.querySelector('[data-testid="sketch-zoom-level"]')!;
		assert.equal(level().textContent, "100%");
		for (const id of ["sketch-zoom-in", "sketch-zoom-out", "sketch-zoom-reset"]) assert.ok(!document.querySelector(`[data-testid="${id}"]`), `${id} is gone`);
		assert.ok(level().className.includes("pointer-events-none"), "it takes no touches");
		assert.equal(level().querySelector("button"), null);
	});

	it("PC shortcuts: E toggles the eraser, 1-5 pick the ink, G changes the paper; modified keys and text fields are left alone", async () => {
		localStorage.removeItem("lh:sketch-pen");
		localStorage.removeItem("lh:sketch-background");
		await mount({ inkKey: "k-keys2", onSubmit: async () => true });
		const pressed = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getAttribute("aria-pressed");
		const paper = (name: string) => document.querySelector(`[data-testid="sketch-paper-${name}"]`)?.getAttribute("aria-pressed");
		await click("sketch-tool-pen");
		await key({ key: "2" });
		assert.equal(pressed("sketch-color-red"), "true");
		await key({ key: "5" });
		assert.equal(pressed("sketch-color-blue"), "true");
		await key({ key: "e" });
		assert.equal(document.querySelector('[data-testid="sketch-eraser"]')!.getAttribute("aria-pressed"), "true");
		await key({ key: "e" });
		assert.equal(document.querySelector('[data-testid="sketch-eraser"]')!.getAttribute("aria-pressed"), "false");
		await key({ key: "g" });
		await click("sketch-more");
		assert.equal(paper("grid"), "true");
		await key({ key: "g", ctrlKey: true });
		assert.equal(paper("grid"), "true", "Ctrl+G is not ours");
		await click("sketch-tool-pen");
		await key({ key: "6" });
		assert.equal(pressed("sketch-color-blue"), "true", "only 1-5");
		await key({ key: "]" });
		await key({ key: "[" });
		await key({ key: "[" });
		assert.equal(pressed("sketch-width-thin"), "true", "[ and ] step the pen width");
		localStorage.removeItem("lh:sketch-pen");
		localStorage.removeItem("lh:sketch-background");
	});

	it("the paper options (none, grid, ruled, dots) are remembered", async () => {
		localStorage.removeItem("lh:sketch-background");
		await mount({ inkKey: "k-paper", onSubmit: async () => true });
		await click("sketch-more");
		const paper = (name: string) => document.querySelector(`[data-testid="sketch-paper-${name}"]`)!.getAttribute("aria-pressed");
		assert.equal(paper("none"), "true");
		for (const name of ["grid", "ruled", "dots", "none"]) {
			await click(`sketch-paper-${name}`);
			assert.equal(paper(name), "true");
		}
		await click("sketch-paper-grid");
		assert.equal(localStorage.getItem("lh:sketch-background"), "grid");
		localStorage.removeItem("lh:sketch-background");
	});

	it("Clear asks for confirmation: Cancel and Esc keep the ink and leave the view open; Clear removes it", async () => {
		writeInk("k-confirm", inkFromStrokes([STROKE, { ...STROKE }]));
		let closed = 0;
		await mount({ inkKey: "k-confirm", onSubmit: async () => true, onClose: () => closed++ });
		const dialog = () => document.querySelector('[data-testid="sketch-clear-dialog"]');
		assert.equal(dialog(), null);
		const clear = async () => {
			await click("sketch-more");
			await click("sketch-clear");
		};
		await clear();
		assert.ok(dialog(), "the dialog opens");
		assert.equal(dialog()!.getAttribute("role"), "alertdialog");
		assert.ok(dialog()!.hasAttribute("data-ink-hole"), "a touch hole: the native layer must not draw under it");
		assert.match(dialog()!.textContent ?? "", /Clear the whole sketch\?/);
		await click("sketch-clear-cancel");
		assert.equal(dialog(), null);
		assert.equal(readInk("k-confirm").strokes.length, 2, "Cancel keeps the ink");
		await clear();
		await key({ key: "Escape" });
		assert.equal(dialog(), null, "Esc closes the dialog");
		assert.equal(closed, 0, "...and only the dialog, not the sketch view");
		assert.equal(readInk("k-confirm").strokes.length, 2);
		await clear();
		await act(async () => {
			assert.equal(handleBack(), true);
		});
		assert.equal(dialog(), null, "the Android back button closes the dialog first");
		assert.equal(closed, 0);
		await clear();
		await click("sketch-clear-confirm");
		assert.equal(readInk("k-confirm").strokes.length, 0, "Clear removes the ink");
		assert.equal(dialog(), null);
	});

	it("the sheet toggle switches light and dark, and is remembered", async () => {
		localStorage.removeItem("lh:sketch-sheet");
		await mount({ inkKey: "k-tone", onSubmit: async () => true });
		const label = () => document.querySelector('[data-testid="sketch-sheet-tone"]')!.getAttribute("aria-label");
		await click("sketch-more");
		assert.equal(label(), "Sheet: light");
		await click("sketch-sheet-tone");
		assert.equal(label(), "Sheet: dark");
		assert.equal(localStorage.getItem("lh:sketch-sheet"), "dark");
		await click("sketch-tool-pen"); // the pen options replace the menu
		const black = () => document.querySelector('[data-testid="sketch-color-black"] span')!.getAttribute("style") ?? "";
		assert.match(black(), /f5f5f4/i, "the black swatch shows the ink as it appears on a dark sheet");
		await click("sketch-more");
		await click("sketch-sheet-tone");
		assert.equal(label(), "Sheet: light");
		localStorage.removeItem("lh:sketch-sheet");
	});

	it("applyOp / revertOp handle a clear", () => {
		const op = { kind: "clear" as const, removed: [STROKE, { ...STROKE }] };
		assert.deepEqual(applyOp([STROKE, op.removed[1]!], op), []);
		assert.equal(revertOp([], op).length, 2);
	});
});

describe("the top bar (M16)", () => {
	const click = (testid: string) =>
		act(async () => {
			document.querySelector(`[data-testid="${testid}"]`)!.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
		});
	const has = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) !== null;
	const toolbarStore = () => (globalThis as unknown as { localStorage: { store: Map<string, string> } }).localStorage.store;

	it("every control lives in the one top bar, ahead of the canvas, and nothing sits below it", async () => {
		await mount({ inkKey: "k-top", onSubmit: async () => true });
		const view = document.querySelector('[data-testid="sketch-view"]')!;
		const toolbar = document.querySelector('[data-testid="sketch-toolbar"]')!;
		assert.equal(view.firstElementChild?.getAttribute("data-testid") ?? view.querySelector("[data-testid]")?.getAttribute("data-testid"), "sketch-toolbar");
		for (const id of ["sketch-close", "sketch-undo", "sketch-redo", "sketch-tool-pen", "sketch-eraser", "sketch-more", "sketch-submit"]) {
			assert.ok(toolbar.querySelector(`[data-testid="${id}"]`), `${id} is in the bar`);
		}
		const canvasWrap = document.querySelector('[data-testid="sketch-canvas"]')!.parentElement!;
		assert.equal(toolbar.compareDocumentPosition(canvasWrap) & 4, 4, "the canvas follows the bar in the document");
		assert.equal(view.lastElementChild === toolbar, false, "the bar is not the last child: no bottom bar");
	});

	it("the options open from the active tool, one panel at a time, and Esc closes the panel before the view", async () => {
		let closed = 0;
		await mount({ inkKey: "k-panel", onSubmit: async () => true, onClose: () => closed++ });
		assert.ok(!has("sketch-panel-pen"));
		await click("sketch-tool-pen");
		assert.ok(has("sketch-panel-pen"));
		await click("sketch-more");
		assert.ok(has("sketch-panel-more") && !has("sketch-panel-pen"), "one panel at a time");
		assert.ok(document.querySelector('[data-testid="sketch-panel-more"]')!.hasAttribute("data-ink-hole"), "a touch hole for the native layer");
		await key({ key: "Escape" });
		assert.ok(!has("sketch-panel-more"));
		assert.equal(closed, 0, "Esc closed the panel only");
		await click("sketch-eraser"); // another tool: switches, no panel
		assert.ok(!has("sketch-panel-eraser"));
		await click("sketch-eraser"); // the active tool again: its options
		assert.ok(has("sketch-panel-eraser"));
		await key({ key: "e" }); // the key switches back to the pen and takes the eraser's panel away
		assert.ok(!has("sketch-panel-eraser"));
	});

	it("the bar folds to a thin tab and comes back; the choice is remembered", async () => {
		toolbarStore().clear();
		await mount({ inkKey: "k-fold", onSubmit: async () => true });
		await click("sketch-more");
		await click("sketch-toolbar-collapse");
		assert.ok(!has("sketch-submit") && has("sketch-toolbar-expand"), "only the tab is left");
		assert.equal((JSON.parse(toolbarStore().get("lh:sketch-toolbar")!) as { collapsed: boolean }).collapsed, true);
		await act(async () => root!.unmount());
		await mount({ inkKey: "k-fold", onSubmit: async () => true });
		assert.ok(has("sketch-toolbar-expand"), "remembered folded");
		await click("sketch-toolbar-expand");
		assert.ok(has("sketch-submit") && !has("sketch-toolbar-expand"));
		toolbarStore().clear();
	});

	it("auto-hide is a switch in the menu, off by default and remembered", async () => {
		toolbarStore().clear();
		await mount({ inkKey: "k-auto", onSubmit: async () => true });
		await click("sketch-more");
		const sw = () => document.querySelector('[data-testid="sketch-autohide"]')!;
		assert.equal(sw().getAttribute("aria-checked"), "false");
		await click("sketch-autohide");
		assert.equal(sw().getAttribute("aria-checked"), "true");
		assert.equal((JSON.parse(toolbarStore().get("lh:sketch-toolbar")!) as { autoHide: boolean }).autoHide, true);
		toolbarStore().clear();
	});

	it("a waiting Submit says why instead of doing nothing, and the message goes when the reason does", async () => {
		await mount({ inkKey: "k-why", onSubmit: async () => true });
		const submit = () => document.querySelector('[data-testid="sketch-submit"]')!;
		assert.equal(submit().getAttribute("aria-disabled"), "true");
		assert.equal(submit().getAttribute("title"), "Draw something first.");
		assert.ok(!has("sketch-status"));
		await click("sketch-submit");
		assert.match(document.querySelector('[data-testid="sketch-status"]')!.textContent ?? "", /Draw something first/);
		assert.equal(document.querySelector('[data-testid="sketch-status"]')!.getAttribute("role"), "status", "announced, not hidden");
	});

	it("a blank page shows a hint; a page with ink does not", async () => {
		await mount({ inkKey: "k-hint", onSubmit: async () => true });
		assert.ok(has("sketch-empty-hint"));
		await act(async () => root!.unmount());
		writeInk("k-hint2", inkFromStrokes([STROKE]));
		await mount({ inkKey: "k-hint2", onSubmit: async () => true });
		assert.ok(!has("sketch-empty-hint"));
	});

	it("a palm next to the pen presses nothing in the bar; the pen itself does", async () => {
		writeInk("k-palm", inkFromStrokes([STROKE]));
		let closed = 0;
		await mount({ inkKey: "k-palm", onSubmit: async () => true, onClose: () => closed++ });
		const { notePenNear, resetPalmGuard } = await import("../components/sketch/palm-guard.ts");
		resetPalmGuard();
		const close = document.querySelector('[data-testid="sketch-close"]')!;
		const press = (pointerType: string, width = 10) =>
			act(async () => {
				close.dispatchEvent(Object.assign(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType, width, height: width }));
				close.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
			});
		await press("touch");
		assert.equal(closed, 1, "a finger with no pen about works");
		notePenNear();
		await press("touch");
		assert.equal(closed, 1, "a touch right after the pen is a palm");
		await press("pen");
		assert.equal(closed, 2, "the pen is never blocked");
		resetPalmGuard();
	});
});

describe("two-finger tap and Space pan (M16)", () => {
	it("two fingers tapping together undo the newest stroke; a pinch does not", async () => {
		const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
		proto.setPointerCapture = () => {};
		proto.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, x: 0, y: 0 });
		writeInk("k-tap", inkFromStrokes([STROKE, { ...STROKE }]));
		await mount({ inkKey: "k-tap", onSubmit: async () => true });
		const canvas = document.querySelector('[data-testid="sketch-canvas"]')!;
		const touch = (type: string, pointerId: number, x: number, y: number) =>
			act(async () => {
				canvas.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { pointerId, pointerType: "touch", clientX: x, clientY: y, button: 0, buttons: 1, pressure: 0.5 }));
			});
		await touch("pointerdown", 1, 100, 100);
		await touch("pointerdown", 2, 200, 100);
		await touch("pointerup", 1, 100, 100);
		await touch("pointerup", 2, 200, 100);
		assert.equal(readInk("k-tap").strokes.length, 1, "a quick two-finger tap is undo");
		// a pinch: the fingers spread, so it is a zoom, not an undo
		await touch("pointerdown", 1, 100, 100);
		await touch("pointerdown", 2, 200, 100);
		await touch("pointermove", 2, 300, 100);
		await touch("pointerup", 1, 100, 100);
		await touch("pointerup", 2, 300, 100);
		assert.equal(readInk("k-tap").strokes.length, 1, "a pinch changes nothing");
	});

	it("holding Space pans a mouse drag; without Space a mouse drag draws", async () => {
		const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
		proto.setPointerCapture = () => {};
		proto.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, x: 0, y: 0 });
		await mount({ inkKey: "k-space", onSubmit: async () => true });
		const canvas = document.querySelector('[data-testid="sketch-canvas"]')!;
		const mouse = (type: string, x: number, y: number) =>
			act(async () => {
				canvas.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { pointerId: 9, pointerType: "mouse", clientX: x, clientY: y, button: 0, buttons: 1, pressure: 0.5 }));
			});
		const keyEvent = (type: string, code: string) =>
			act(async () => {
				window.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { code, key: " ", ctrlKey: false, metaKey: false, altKey: false }));
			});
		const before = document.querySelector('[data-testid="sketch-zoom-level"]')!.textContent;
		await keyEvent("keydown", "Space");
		await mouse("pointerdown", 100, 100);
		await mouse("pointermove", 160, 140);
		await mouse("pointerup", 160, 140);
		await keyEvent("keyup", "Space");
		assert.equal(readInk("k-space").strokes.length, 0, "Space held: the drag panned, it drew nothing");
		assert.equal(document.querySelector('[data-testid="sketch-zoom-level"]')!.textContent, before, "a pan does not zoom");
		await mouse("pointerdown", 100, 100);
		await mouse("pointermove", 160, 140);
		await mouse("pointerup", 160, 140);
		assert.equal(readInk("k-space").strokes.length, 1, "no Space: the drag draws");
	});
});

describe("hold to straighten (M16c)", () => {
	const setup = async (key: string) => {
		const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
		proto.setPointerCapture = () => {};
		proto.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, x: 0, y: 0 });
		await mount({ inkKey: key, onSubmit: async () => true });
		const canvas = document.querySelector('[data-testid="sketch-canvas"]')!;
		const mouse = (type: string, x: number, y: number) =>
			act(async () => {
				canvas.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { pointerId: 5, pointerType: "mouse", clientX: x, clientY: y, button: 0, buttons: 1, pressure: 0.5 }));
			});
		return { mouse };
	};
	const wait = (ms: number) => act(async () => await new Promise((r) => setTimeout(r, ms)));

	it("a stroke held still at its end becomes a straight line, the angle snapped", async () => {
		const { mouse } = await setup("k-hold");
		await mouse("pointerdown", 100, 100);
		await mouse("pointermove", 150, 101);
		await mouse("pointermove", 200, 104);
		await wait(650); // hold
		await mouse("pointerup", 200, 104);
		const strokes = readInk("k-hold").strokes;
		assert.equal(strokes.length, 1);
		const ys = strokes[0]!.points.filter((_, i) => i % 3 === 1);
		assert.ok(ys.every((y) => Math.abs(y - ys[0]!) < 1e-6), "every point is on the horizontal line");
		assert.ok(strokes[0]!.points.length / 3 > 10, "written as a line of evenly spaced points");
	});

	it("a stroke that keeps moving, or is lifted at once, stays as drawn", async () => {
		const { mouse } = await setup("k-nohold");
		await mouse("pointerdown", 100, 100);
		await mouse("pointermove", 150, 130);
		await mouse("pointermove", 200, 104);
		await mouse("pointerup", 200, 104);
		await wait(650);
		const points = readInk("k-nohold").strokes[0]!.points;
		assert.equal(points.length / 3, 3, "the three points drawn, nothing replaced");
	});

	it("a held line follows the pen from then on", async () => {
		const { mouse } = await setup("k-follow");
		await mouse("pointerdown", 100, 100);
		await mouse("pointermove", 200, 100);
		await wait(650);
		await mouse("pointermove", 200, 200); // still held: the line swings to the new end (a 45 degree snap)
		await mouse("pointerup", 200, 200);
		const p = readInk("k-follow").strokes[0]!.points;
		const last = { x: p[p.length - 3]!, y: p[p.length - 2]! };
		assert.ok(Math.abs(last.x - 200) < 1e-6 && Math.abs(last.y - 200) < 1e-6, `ends at the pen (${last.x}, ${last.y})`);
		for (let i = 0; i < p.length; i += 3) assert.ok(Math.abs(p[i]! - 100 - (p[i + 1]! - 100)) < 1e-6, "on the 45 degree line from the start");
	});
});

describe("the paper spacing slider", () => {
	const click = (id: string) =>
		act(async () => {
			document.querySelector(`[data-testid="${id}"]`)!.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
		});

	it("shows only with a paper, snaps to six steps and labels the spacing of the paper in use", async () => {
		localStorage.removeItem("lh:sketch-background");
		localStorage.removeItem("lh:sketch-paper-size");
		await mount({ inkKey: "k-paper-size", onSubmit: async () => true });
		await click("sketch-more");
		assert.ok(!document.querySelector('[data-testid="sketch-paper-size"]'), "no paper, no spacing");
		await click("sketch-paper-ruled");
		const slider = () => document.querySelector('[data-testid="sketch-paper-size"]')!;
		assert.equal(slider().getAttribute("max"), "5");
		assert.equal(slider().getAttribute("step"), "1", "it snaps");
		assert.equal(document.querySelector('[data-testid="sketch-paper-size-label"]')!.textContent, "40 px");
		// the label follows the paper: a grid is 32 px at the middle step
		await click("sketch-paper-grid");
		assert.equal(document.querySelector('[data-testid="sketch-paper-size-label"]')!.textContent, "32 px");
		assert.equal(slider().getAttribute("aria-valuetext"), "32 px");
		localStorage.removeItem("lh:sketch-background");
		localStorage.removeItem("lh:sketch-paper-size");
	});
});
