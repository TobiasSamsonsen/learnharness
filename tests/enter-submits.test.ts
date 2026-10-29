/**
 * enter-submits + focus-hygiene — the pointer/keyboard Enter split and the
 * transient-control blur (owner, keyboard round 2026-10-10).
 *
 * The regression this pins: clicking a transcript control (a thinking
 * toggle) left focus on its <button>; the learner's next Enter re-activated
 * the toggle instead of submitting. The law now: Enter from a
 * POINTER-focused transcript button submits (the window listener also
 * preventDefaults, suppressing the default activation underneath);
 * keyboard-focused buttons and buttons inside open overlays (menus walk
 * focus with arrows, dialogs are their own layer) keep native Enter.
 */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { afterEach, describe, it } from "node:test";
import { buttonKeepsNativeEnter, enterSends, hasHardwareKeyboard, isCoarsePointer, noteKeydown, resetHardwareKeyboard } from "../components/enter-submits.ts";
import { blurAfterPointerClick } from "../components/focus-hygiene.ts";

const { document } = parseHTML("<html><body></body></html>");

function buttonIn(attrs: Record<string, string>): HTMLElement {
	const host = document.createElement("div");
	for (const [k, v] of Object.entries(attrs)) host.setAttribute(k, v);
	const b = document.createElement("button");
	b.type = "button";
	host.appendChild(b);
	document.body.appendChild(host);
	return b;
}

describe("buttonKeepsNativeEnter (the pointer/keyboard Enter split)", () => {
	it("a transcript button (pointer-focused) does NOT keep native Enter — Enter submits", () => {
		const b = buttonIn({});
		assert.equal(buttonKeepsNativeEnter(b), false);
	});

	it("a keyboard-focused button keeps native Enter (:focus-visible)", () => {
		const b = buttonIn({});
		// linkedom lacks the pseudo — stub the one call the helper makes.
		(b as unknown as { matches: (sel: string) => boolean }).matches = (sel: string) =>
			sel === ":focus-visible";
		assert.equal(buttonKeepsNativeEnter(b), true);
	});

	it("buttons inside overlays keep native Enter: hand-rolled menu, Radix popper, dialog, menu role", () => {
		assert.equal(buttonKeepsNativeEnter(buttonIn({ "data-lh-menu": "" })), true);
		assert.equal(
			buttonKeepsNativeEnter(buttonIn({ "data-radix-popper-content-wrapper": "" })),
			true,
		);
		assert.equal(buttonKeepsNativeEnter(buttonIn({ role: "dialog" })), true);
		assert.equal(buttonKeepsNativeEnter(buttonIn({ role: "menu" })), true);
	});

	it("a selector engine without :focus-visible degrades to pointer-focus, never throws", () => {
		const b = buttonIn({});
		assert.doesNotThrow(() => buttonKeepsNativeEnter(b));
		assert.equal(buttonKeepsNativeEnter(b), false);
	});
});

describe("blurAfterPointerClick (focus hygiene)", () => {
	it("a POINTER click (detail > 0) blurs the transient control", () => {
		const b = buttonIn({});
		let blurred = false;
		b.blur = () => {
			blurred = true;
		};
		blurAfterPointerClick({ detail: 1, currentTarget: b });
		assert.equal(blurred, true);
	});

	it("a KEYBOARD-activated click (detail 0) keeps focus", () => {
		const b = buttonIn({});
		let blurred = false;
		b.blur = () => {
			blurred = true;
		};
		blurAfterPointerClick({ detail: 0, currentTarget: b });
		assert.equal(blurred, false);
	});
});

describe("enterSends (the shared send chord; coarse pointers type newlines)", () => {
	const key = (over: Partial<{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ({
		key: "Enter",
		shiftKey: false,
		metaKey: false,
		ctrlKey: false,
		...over,
	});

	it("fine pointer: Enter sends, Shift+Enter is a newline, ⌘/Ctrl+Enter send", () => {
		assert.equal(enterSends(key(), false), true);
		assert.equal(enterSends(key({ shiftKey: true }), false), false);
		assert.equal(enterSends(key({ metaKey: true }), false), true);
		assert.equal(enterSends(key({ ctrlKey: true }), false), true);
		assert.equal(enterSends(key({ ctrlKey: true, shiftKey: true }), false), true, "the old (!shift || meta || ctrl) chord");
	});

	it("coarse pointer: plain Enter is a newline; ⌘/Ctrl+Enter still send", () => {
		assert.equal(enterSends(key(), true), false);
		assert.equal(enterSends(key({ shiftKey: true }), true), false);
		assert.equal(enterSends(key({ metaKey: true }), true), true);
		assert.equal(enterSends(key({ ctrlKey: true }), true), true);
	});

	it("other keys never send", () => {
		assert.equal(enterSends(key({ key: "a" }), false), false);
		assert.equal(enterSends(key({ key: "a", ctrlKey: true }), true), false);
	});

	it("isCoarsePointer reads matchMedia at call time and degrades to fine", () => {
		const g = globalThis as { window?: unknown };
		const prev = g.window;
		try {
			g.window = undefined;
			assert.equal(isCoarsePointer(), false, "no window (SSR)");
			g.window = {};
			assert.equal(isCoarsePointer(), false, "no matchMedia");
			g.window = { matchMedia: (q: string) => ({ matches: q === "(pointer: coarse)" }) };
			assert.equal(isCoarsePointer(), true);
			g.window = { matchMedia: () => ({ matches: false }) };
			assert.equal(isCoarsePointer(), false);
			g.window = { matchMedia: () => { throw new Error("boom"); } };
			assert.equal(isCoarsePointer(), false, "a throwing host never breaks typing");
		} finally {
			g.window = prev;
		}
	});
});

describe("a physical keyboard on a touch device (M13e)", () => {
	afterEach(() => resetHardwareKeyboard());

	it("the soft keyboard does not count: no code, Unidentified, Process, composing", () => {
		for (const e of [{ key: "Enter" }, { key: "a", code: "" }, { key: "Unidentified", code: "KeyA" }, { key: "Process", code: "KeyA" }, { key: "a", code: "KeyA", isComposing: true }]) {
			noteKeydown(e);
			assert.equal(hasHardwareKeyboard(), false, JSON.stringify(e));
		}
	});

	it("one real key flips it: a coarse device then sends on plain Enter, like a PC", () => {
		const prior = (globalThis as { window?: unknown }).window;
		(globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: true }) };
		try {
			assert.equal(isCoarsePointer(), true);
			assert.equal(enterSends({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false }), false, "soft keyboard: Enter is a newline");
			noteKeydown({ key: "a", code: "KeyA" });
			assert.equal(hasHardwareKeyboard(), true);
			assert.equal(isCoarsePointer(), false);
			assert.equal(enterSends({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false }), true, "a keyboard is attached: Enter sends");
			assert.equal(enterSends({ key: "Enter", shiftKey: true, metaKey: false, ctrlKey: false }), false, "Shift+Enter stays a newline");
		} finally {
			(globalThis as { window?: unknown }).window = prior;
		}
	});
});
