/**
 * The pure parts of the sketch view's top bar (M16, docs/android/m16-plan.md): the palm guard's rule, the status line and
 * the Submit-waiting reasons, and the bar's remembered preferences.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
	key: () => null,
	length: 0,
} as Storage;

const { isPalmTouch, notePenNear, resetPalmGuard, PALM_CONTACT_PX, PALM_GUARD_MS } = await import("../components/sketch/palm-guard.ts");
const { limitShare, sketchStatus, submitBlockReason, LIMIT_WARN_SHARE } = await import("../components/sketch/sketch-status.ts");
const { DEFAULT_TOOLBAR, loadToolbar, saveToolbar } = await import("../components/sketch/pen-settings.ts");

describe("the palm guard", () => {
	beforeEach(() => resetPalmGuard());
	const finger = { pointerType: "touch", width: 10, height: 10 };

	it("blocks a touch right after the pen was near, and lets it through later", () => {
		notePenNear(1000);
		assert.equal(isPalmTouch(finger, 1000 + PALM_GUARD_MS - 1, 1000, true), true);
		assert.equal(isPalmTouch(finger, 1000 + PALM_GUARD_MS, 1000, true), false);
	});

	it("blocks a large contact patch, but only once a pen has been seen", () => {
		const palm = { pointerType: "touch", width: PALM_CONTACT_PX, height: 8 };
		assert.equal(isPalmTouch(palm, 5000, -Infinity, true), true);
		assert.equal(isPalmTouch({ ...palm, width: 8, height: PALM_CONTACT_PX }, 5000, -Infinity, true), true, "tall counts too");
		assert.equal(isPalmTouch(palm, 5000, -Infinity, false), false, "a person who never used a pen is never affected");
		assert.equal(isPalmTouch({ ...palm, width: PALM_CONTACT_PX - 1 }, 5000, -Infinity, true), false);
	});

	it("never blocks the pen or the mouse", () => {
		notePenNear(1000);
		assert.equal(isPalmTouch({ pointerType: "pen", width: 50, height: 50 }, 1001, 1000, true), false);
		assert.equal(isPalmTouch({ pointerType: "mouse", width: 50, height: 50 }, 1001, 1000, true), false);
	});

	it("uses the module's own pen memory by default", () => {
		assert.equal(isPalmTouch(finger, 10), false);
		notePenNear(10);
		assert.equal(isPalmTouch(finger, 20), true);
	});
});

describe("the status line", () => {
	const idle = { error: null, nativeFallback: null, disabled: false, keptStatus: "ready" as const, share: 0 };

	it("says nothing when all is well", () => {
		assert.equal(sketchStatus(idle), null);
	});

	it("puts a refusal first, as an alert", () => {
		assert.deepEqual(sketchStatus({ ...idle, error: "sketch has more than 3000 strokes", disabled: true }), { kind: "error", text: "sketch has more than 3000 strokes" });
	});

	it("explains a waiting state", () => {
		assert.match(sketchStatus({ ...idle, disabled: true })!.text, /Compacting/);
		assert.match(sketchStatus({ ...idle, keptStatus: "loading" })!.text, /Loading/);
		assert.equal(sketchStatus({ ...idle, blocked: "Pick an answer first" })!.text, "Pick an answer first");
		assert.equal(sketchStatus({ ...idle, keptStatus: "failed" })!.kind, "warn");
		assert.match(sketchStatus({ ...idle, nativeFallback: "no surface" })!.text, /no surface/);
	});

	it("warns from 80 percent of the page's limits and refuses at 100", () => {
		assert.equal(sketchStatus({ ...idle, share: LIMIT_WARN_SHARE - 0.01 }), null);
		const warn = sketchStatus({ ...idle, share: 0.85 })!;
		assert.equal(warn.kind, "warn");
		assert.match(warn.text, /85% full/);
		assert.equal(sketchStatus({ ...idle, share: 1 })!.kind, "error");
	});

	it("measures the larger of the stroke and point shares", () => {
		assert.equal(limitShare([]), 0);
		const few = Array.from({ length: 300 }, () => ({ points: [0, 0, 0.5, 1, 1, 0.5] }));
		assert.equal(limitShare(few), 300 / 3000);
		const long = [{ points: new Array(3 * 200_000).fill(0) }];
		assert.equal(limitShare(long), 200_000 / 250_000);
	});

	it("gives the reason Submit waits, in the order a learner can act on", () => {
		const ok = { empty: false, disabled: false, keptStatus: "ready" as const };
		assert.equal(submitBlockReason(ok), null);
		assert.equal(submitBlockReason({ ...ok, empty: true }), "Draw something first.");
		assert.equal(submitBlockReason({ ...ok, empty: true, keptStatus: "loading" }), "Loading your earlier page…");
		assert.equal(submitBlockReason({ ...ok, empty: true, blocked: "Pick an answer first" }), "Pick an answer first");
		assert.equal(submitBlockReason({ ...ok, empty: true, blocked: "x", disabled: true }), "Compacting the session…");
	});
});

describe("the bar's remembered settings", () => {
	beforeEach(() => store.clear());

	it("default to a full bar that stays", () => {
		assert.deepEqual(loadToolbar(), DEFAULT_TOOLBAR);
		assert.deepEqual(DEFAULT_TOOLBAR, { collapsed: false, autoHide: false });
	});

	it("survive a reload; damaged values fall back", () => {
		saveToolbar({ collapsed: true, autoHide: true });
		assert.deepEqual(loadToolbar(), { collapsed: true, autoHide: true });
		store.set("lh:sketch-toolbar", "not json");
		assert.deepEqual(loadToolbar(), DEFAULT_TOOLBAR);
		store.set("lh:sketch-toolbar", JSON.stringify({ collapsed: "yes", autoHide: 1 }));
		assert.deepEqual(loadToolbar(), DEFAULT_TOOLBAR, "only real booleans count");
	});
});
