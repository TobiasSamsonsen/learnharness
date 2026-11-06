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
const { readInk, writeInk, inkFromStrokes, writeKept, readKept, pagePayload } = await import("../components/sketch/ink-memory.ts");
const { planSketch } = await import("../src/core/index.ts");
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
		assert.ok(byId("sketch-native-surface"), "native by default");
		assert.equal(byId("sketch-canvas"), null);
		assert.ok(shell.posted.some((l) => l.startsWith("open k-default ")));
	});

	it("the learner turned it off: the web canvas, nothing posted", async () => {
		store.set("lh:native-ink", "off");
		const shell = fakeShell();
		await mount("k-off");
		assert.ok(byId("sketch-canvas"), "the web canvas");
		assert.equal(byId("sketch-native-surface"), null);
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
		assert.ok(shell.posted.includes("brush #111111 4"), "the pen goes to the shell, default ink first");
		assert.ok(shell.posted.includes("kept []"));
		assert.ok(shell.posted.includes(`strokes ${JSON.stringify([STROKE])}`), "the store's strokes go to the shell");
		assert.ok(byId("sketch-native-surface"), "a transparent surface instead of the canvas");
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

	it("a pixel-eraser gesture from the shell cuts the stroke it passed over, as one undoable step", async () => {
		store.delete("lh:sketch-eraser"); // the default: part of a stroke
		writeInk("k-cut", inkFromStrokes([STROKE, NATIVE_STROKE]));
		const shell = fakeShell();
		await mount("k-cut");
		await shell.say("erase 150,40"); // on STROKE (90,50 → 200,30), clear of NATIVE_STROKE
		const now = readInk("k-cut").strokes;
		assert.ok(now.length >= 3, `STROKE is cut in two: ${now.length} strokes`);
		assert.equal(now.at(-1), NATIVE_STROKE, "the untouched stroke is still last");
		await click("sketch-undo");
		assert.deepEqual(readInk("k-cut").strokes, [STROKE, NATIVE_STROKE], "undo puts the whole stroke back");
	});

	it("an eraser gesture from the shell removes the stroke it touched, as one undoable step", async () => {
		store.set("lh:sketch-eraser", JSON.stringify({ mode: "stroke", radius: 10 }));
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

	it("the page announces `caps hits` when it opens the layer", async () => {
		const shell = fakeShell();
		await mount("k-caps");
		assert.ok(shell.posted.includes("caps hits"), shell.posted.join(" | "));
	});

	it("`erased`: the page applies the shell's hits as they are (one undo step) and answers with an ack, not a full push", async () => {
		store.set("lh:sketch-eraser", JSON.stringify({ mode: "stroke", radius: 10 }));
		writeInk("k-erased", inkFromStrokes([STROKE, NATIVE_STROKE]));
		const shell = fakeShell();
		await mount("k-erased");
		const before = shell.posted.length;
		await shell.say("erased 2 0"); // the shell holds two strokes and already removed the first
		assert.deepEqual(readInk("k-erased").strokes, [NATIVE_STROKE]);
		assert.deepEqual(shell.posted.slice(before).filter((l) => l.startsWith("strokes ") || l === "ack"), ["ack"], "an ack and no strokes push");
		await click("sketch-undo");
		assert.equal(readInk("k-erased").strokes.length, 2, "the erase is one step");
		assert.equal(shell.posted.at(-1), `strokes ${JSON.stringify([STROKE, NATIVE_STROKE])}`, "an undo is pushed whole: the shell must show the stroke again");
	});

	it("`erased` with nothing hit changes nothing and posts nothing", async () => {
		store.set("lh:sketch-eraser", JSON.stringify({ mode: "stroke", radius: 10 }));
		writeInk("k-erased-none", inkFromStrokes([STROKE, NATIVE_STROKE]));
		const shell = fakeShell();
		await mount("k-erased-none");
		const before = shell.posted.length;
		await shell.say("erased 2");
		assert.equal(readInk("k-erased-none").strokes.length, 2);
		assert.deepEqual(shell.posted.slice(before), []);
	});

	it("`erased` with a count that is not the page's: the page's strokes win, pushed whole, and nothing is erased", async () => {
		store.set("lh:sketch-eraser", JSON.stringify({ mode: "stroke", radius: 10 }));
		writeInk("k-erased-skew", inkFromStrokes([STROKE, NATIVE_STROKE]));
		const shell = fakeShell();
		await mount("k-erased-skew");
		await shell.say("erased 3 0"); // the shell thinks it holds three strokes
		assert.equal(readInk("k-erased-skew").strokes.length, 2, "nothing erased on a disagreement");
		assert.equal(shell.posted.at(-2), `strokes ${JSON.stringify([STROKE, NATIVE_STROKE])}`);
		assert.equal(shell.posted.at(-1), "kept []", "and the sent page too (none here)");
	});

	it("an older shell still works: `erase <points>` is applied by the page and the result pushed whole, as before", async () => {
		store.set("lh:sketch-eraser", JSON.stringify({ mode: "stroke", radius: 10 }));
		writeInk("k-older", inkFromStrokes([STROKE, NATIVE_STROKE]));
		const shell = fakeShell();
		await mount("k-older");
		await shell.say("erase 200,30,201,30");
		assert.deepEqual(readInk("k-older").strokes, [NATIVE_STROKE]);
		assert.equal(shell.posted.at(-1), `strokes ${JSON.stringify([NATIVE_STROKE])}`, "a shell that never said `erased` gets the whole set");
	});

	it("the stroke eraser reaches SENT ink: `erased` indexes after the working strokes thaw the kept page and remove that stroke, whole, as one undo step", async () => {
		store.set("lh:sketch-eraser", JSON.stringify({ mode: "stroke", radius: 10 }));
		const old: SketchStroke = { size: 4, points: [0, 100, 0.5, 200, 100, 0.5] }; // sent earlier
		const old2: SketchStroke = { size: 4, points: [0, 150, 0.5, 200, 150, 0.5] };
		const added: SketchStroke = { size: 4, points: [0, 300, 0.5, 100, 300, 0.5] }; // written since
		writeKept("k-erased-old", { id: "sk_oldoldold0000007", strokes: [old, old2] });
		writeInk("k-erased-old", inkFromStrokes([added]));
		const shell = fakeShell();
		await mount("k-erased-old");
		assert.ok(shell.posted.includes(`kept ${JSON.stringify([old, old2])}`), "the shell is shown the sent page, to dim and to hit-test");
		const before = shell.posted.length;
		await shell.say("erased 3 1"); // the shell holds 1 working + 2 sent strokes; the first sent one (index 1) went
		const ink = readInk("k-erased-old");
		assert.equal(ink.thawed, "sk_oldoldold0000007", "the first touch thaws the sent page");
		assert.equal(ink.strokes[0], added, "the unsent stroke keeps its place");
		assert.deepEqual(ink.strokes.slice(1), [{ ...old2, fresh: false }], "the touched sent stroke is gone whole, the other stays (still marked sent)");
		const after = shell.posted.slice(before);
		assert.ok(after.some((l) => l.startsWith("strokes ")), "the page's shape changed: pushed whole, not acknowledged");
		assert.ok(!after.includes("ack"));
		assert.ok(after.includes("kept []"), "the sent page now lives in the working strokes");
		await click("sketch-undo");
		assert.deepEqual(readInk("k-erased-old").strokes.slice(1), [{ ...old, fresh: false }, { ...old2, fresh: false }], "one undo puts it back, dimmed");
	});

	it("an older shell's `erase <points>` reaches SENT ink in stroke mode too (the page counts the sent page after the working strokes)", async () => {
		store.set("lh:sketch-eraser", JSON.stringify({ mode: "stroke", radius: 10 }));
		const old: SketchStroke = { size: 4, points: [0, 100, 0.5, 200, 100, 0.5] };
		writeKept("k-older-old", { id: "sk_oldoldold0000006", strokes: [old] });
		writeInk("k-older-old", inkFromStrokes([NATIVE_STROKE]));
		const shell = fakeShell();
		await mount("k-older-old");
		await shell.say("erase 100,102");
		const ink = readInk("k-older-old");
		assert.equal(ink.thawed, "sk_oldoldold0000006");
		assert.deepEqual(ink.strokes, [NATIVE_STROKE], "only the unsent stroke is left");
	});

	it("`erased` with the wrong total (the sent page counted or not): the page wins, both lists pushed whole, nothing erased", async () => {
		store.set("lh:sketch-eraser", JSON.stringify({ mode: "stroke", radius: 10 }));
		const old: SketchStroke = { size: 4, points: [0, 100, 0.5, 200, 100, 0.5] };
		writeKept("k-erased-skew2", { id: "sk_oldoldold0000005", strokes: [old] });
		writeInk("k-erased-skew2", inkFromStrokes([NATIVE_STROKE]));
		const shell = fakeShell();
		await mount("k-erased-skew2");
		await shell.say("erased 1 0"); // an older count that forgot the sent page
		assert.equal(readInk("k-erased-skew2").thawed, undefined, "nothing thawed");
		assert.equal(readInk("k-erased-skew2").strokes.length, 1);
		assert.equal(shell.posted.at(-1), `kept ${JSON.stringify([old])}`);
		assert.equal(shell.posted.at(-2), `strokes ${JSON.stringify([NATIVE_STROKE])}`);
	});

	it("erasing part of SENT ink thaws the kept page: one undo step, edited pieces are bracketed, a pure unsent page is untouched", async () => {
		store.delete("lh:sketch-eraser"); // the default: part of a stroke
		const old: SketchStroke = { size: 4, points: [0, 100, 0.5, 200, 100, 0.5] }; // sent earlier
		const added: SketchStroke = { size: 4, points: [0, 300, 0.5, 100, 300, 0.5] }; // written since
		writeKept("k-thaw", { id: "sk_oldoldold0000009", strokes: [old] });
		writeInk("k-thaw", inkFromStrokes([added]));
		const shell = fakeShell();
		await mount("k-thaw");
		await shell.say("erase 100,100"); // through the middle of the sent stroke
		const ink = readInk("k-thaw");
		assert.equal(ink.thawed, "sk_oldoldold0000009");
		assert.equal(ink.strokes[0], added, "the unsent strokes keep their places");
		assert.ok(ink.strokes.length >= 3, `the sent stroke became pieces: ${ink.strokes.length}`);
		const pieces = ink.strokes.slice(1);
		assert.ok(pieces.every((s) => s.fresh === undefined), "the pieces are edited ink");
		// what goes out: nothing of the sent stroke is left plain, the pieces and the new stroke are flagged
		const payload = pagePayload(readKept("k-thaw"), ink.strokes, "web-canvas", true);
		assert.equal(payload.strokes.length, ink.strokes.length);
		assert.ok(payload.strokes.every((s) => s.fresh === true), "every stroke here is new or edited");
		assert.match(planSketch(payload)[0]!.svg, /stroke="#d946ef"/, "the margin bracket marks the edit");
		// one undo puts the sent stroke back whole (still thawed, still dimmed)
		await click("sketch-undo");
		const undone = readInk("k-thaw");
		assert.equal(undone.strokes.length, 2);
		assert.deepEqual(undone.strokes[1], { ...old, fresh: false });
		// it survives a reload: the whole page is stored with which strokes were sent
		const saved = JSON.parse(store.get("lh:ink:k-thaw")!);
		assert.equal(saved.thawed, "sk_oldoldold0000009");
		assert.deepEqual(saved.sent, [1]);
	});

	it("a thawed page goes out whole, and once the server accepts it that page is the kept page and nothing is left unsent", async () => {
		store.delete("lh:sketch-eraser");
		const old: SketchStroke = { size: 4, points: [0, 100, 0.5, 200, 100, 0.5] };
		writeKept("k-thaw2", { id: "sk_oldoldold0000010", strokes: [old] });
		const shell = fakeShell();
		let sent: SketchPayload | null = null;
		await mount("k-thaw2", async (s) => ((sent = s), true));
		await shell.say("erase 100,100");
		await key({ key: "Enter", ctrlKey: true });
		await act(async () => await new Promise((r) => setTimeout(r, 0)));
		assert.notEqual(sent, null, "a pure edit of sent ink can be submitted");
		assert.ok(sent!.strokes.length >= 2 && sent!.strokes.every((s) => s.fresh === true));
		assert.equal(readInk("k-thaw2").strokes.length, 0);
		assert.equal(readInk("k-thaw2").thawed, undefined);
		assert.ok(readKept("k-thaw2")!.strokes.every((s) => s.fresh === undefined), "the kept page carries no flags");
	});

	it("the shell's two-finger gestures become the view and go back to the shell", async () => {
		const shell = fakeShell();
		await mount("k-gesture");
		const views = () => shell.posted.filter((l) => l.startsWith("view "));
		assert.equal(views().at(-1), "view 1.0000 0 0", "opens on the home view");
		await shell.say("gesture 0 0 2 100 100"); // a pinch to 2x about (100, 100)
		assert.equal(views().at(-1), "view 2.0000 50 50", "the point under the fingers stays under them");
		await shell.say("gesture 20 10 1 120 110"); // the fingers move (20, 10) without pinching
		assert.equal(views().at(-1), "view 2.0000 40 45", "the content follows the fingers");
		assert.equal(byId("sketch-zoom-level")!.textContent, "200%");
		assert.equal(byId("sketch-zoom-in"), null, "no zoom buttons: the number is only shown");
		await shell.say("gesture 0 0 0.8 100 100"); // a pinch back to 1.6x
		assert.ok(views().at(-1)!.startsWith("view 1.6000 "), views().at(-1));
		assert.equal(byId("sketch-zoom-level")!.textContent, "160%");
		await shell.say("gesture 0 0 1000 5 5");
		assert.ok(views().at(-1)!.startsWith("view 8.0000 "), "the zoom stops at 8x");
	});

	it("touches that reach the page pinch the view only as two settled fingertips: a resting palm does not zoom it (owner, 2026-10-31)", async () => {
		const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
		proto.setPointerCapture = () => {};
		fakeShell();
		await mount("k-palm");
		const surface = byId("sketch-native-surface")!;
		const touch = (type: string, pointerId: number, x: number, y: number, size = [4, 4]) =>
			act(async () => {
				surface.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { pointerId, pointerType: "touch", clientX: x, clientY: y, width: size[0], height: size[1] }));
			});
		const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 150));
		const zoom = () => byId("sketch-zoom-level")!.textContent;
		// a palm edge (6 x 15) beside a fingertip, however long it rests and however far it drifts
		await touch("pointerdown", 1, 100, 200);
		await touch("pointerdown", 2, 150, 200, [6, 15]);
		await settled();
		await touch("pointermove", 2, 160, 200, [6, 15]);
		await touch("pointermove", 2, 350, 200, [6, 15]);
		assert.equal(zoom(), "100%", "a palm-shaped touch cannot pinch");
		await touch("pointerup", 2, 350, 200);
		await touch("pointerup", 1, 100, 200);
		// a third touch ends a pinch, and lifting it does not zoom by itself
		await touch("pointerdown", 3, 100, 200);
		await touch("pointerdown", 4, 200, 200);
		await settled();
		await touch("pointermove", 4, 200, 200); // the baseline
		await touch("pointerdown", 5, 300, 400);
		await touch("pointermove", 4, 350, 200);
		assert.equal(zoom(), "100%", "three touches are not a pinch");
		await touch("pointerup", 5, 300, 400);
		await touch("pointerup", 4, 350, 200);
		await touch("pointerup", 3, 100, 200);
		// two settled fingertips pinch as before
		await touch("pointerdown", 6, 100, 200);
		await touch("pointerdown", 7, 200, 200);
		await touch("pointermove", 7, 300, 200);
		assert.equal(zoom(), "100%", "not before the touches settle");
		await settled();
		await touch("pointermove", 7, 300, 200); // the baseline
		await touch("pointermove", 7, 400, 200); // 200 apart to 300 apart
		assert.equal(zoom(), "150%");
		await touch("pointerup", 7, 400, 200);
		await touch("pointerup", 6, 100, 200);
	});

	it("the eraser's reach is on screen: zoomed in, the same gesture reaches less of the page", async () => {
		store.set("lh:sketch-eraser", JSON.stringify({ mode: "stroke", radius: 20 }));
		const line: SketchStroke = { size: 4, points: [0, 100, 0.5, 200, 100, 0.5] };
		const shell = fakeShell();
		writeInk("k-reach", inkFromStrokes([line]));
		await mount("k-reach");
		await shell.say("erase 100,115"); // 15 away: within 20 + 2 at zoom 1
		assert.equal(readInk("k-reach").strokes.length, 0, "reached at 1x");
		await click("sketch-undo");
		await shell.say("gesture 0 0 2 100 100"); // 2x: the reach is 10 world px (+ 2), so 15 away is out of it
		await shell.say("erase 100,115");
		assert.equal(readInk("k-reach").strokes.length, 1, "not reached at 2x");
	});

	it("the sheet's tone follows to the shell (dark shows ink in lighter colours there)", async () => {
		store.delete("lh:sketch-sheet");
		const shell = fakeShell();
		await mount("k-sheet");
		assert.ok(shell.posted.includes("sheet light"), shell.posted.join(" | "));
		await click("sketch-more");
		await click("sketch-sheet-tone");
		assert.equal(shell.posted.filter((l) => l.startsWith("sheet ")).at(-1), "sheet dark");
		await click("sketch-sheet-tone");
		assert.equal(shell.posted.filter((l) => l.startsWith("sheet ")).at(-1), "sheet light");
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
		assert.equal(byId("sketch-native-surface"), null);
		assert.equal(shell.posted.at(-1), "close", "the shell is told to close the layer");
		assert.ok(!document.documentElement.classList.contains("lh-native-ink"));
		assert.match(document.body.textContent ?? "", /native ink unavailable \(no surface\)/i);
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
