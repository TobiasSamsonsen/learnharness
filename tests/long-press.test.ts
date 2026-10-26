/**
 * The long-press tooltip machine (components/ui/long-press.ts): touch arms,
 * a hold past the slop is a scroll, the release of the press that showed the
 * label is swallowed exactly once, mouse and pen never arm.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	LONG_PRESS_IDLE,
	LONG_PRESS_MS,
	LONG_PRESS_SHOW_MS,
	LONG_PRESS_SLOP,
	longPress,
	ownsContextMenu,
	swallowsClick,
	type LongPress,
	type LongPressEvent,
} from "../components/ui/long-press.ts";

const run = (events: LongPressEvent[], from: LongPress = LONG_PRESS_IDLE) => events.reduce(longPress, from);
const touchDown: LongPressEvent = { type: "down", x: 100, y: 100, pointerType: "touch" };

describe("long-press machine", () => {
	it("the timings are the owner's: 500 ms to show, ~2 s up", () => {
		assert.equal(LONG_PRESS_MS, 500);
		assert.equal(LONG_PRESS_SHOW_MS, 2000);
	});

	it("a touch hold arms, then fires to shown with the click swallow set", () => {
		assert.deepEqual(run([touchDown]), { phase: "armed", x: 100, y: 100 });
		assert.deepEqual(run([touchDown, { type: "fire" }]), { phase: "shown", swallow: true });
	});

	it("mouse and pen never arm — Radix hover and focus own them", () => {
		for (const pointerType of ["mouse", "pen"]) {
			assert.deepEqual(run([{ type: "down", x: 1, y: 1, pointerType }, { type: "fire" }]), LONG_PRESS_IDLE);
		}
	});

	it("a quick tap (up before the timer) never shows and never swallows", () => {
		const s = run([touchDown, { type: "up" }]);
		assert.deepEqual(s, LONG_PRESS_IDLE);
		assert.equal(swallowsClick(s), false);
		assert.deepEqual(longPress(s, { type: "fire" }), LONG_PRESS_IDLE, "a late timer cannot resurrect it");
	});

	it("moving past the slop is a scroll or drag: disarmed", () => {
		assert.deepEqual(run([touchDown, { type: "move", x: 100 + LONG_PRESS_SLOP, y: 100 }]).phase, "armed", "within the slop");
		assert.deepEqual(run([touchDown, { type: "move", x: 100 + LONG_PRESS_SLOP + 1, y: 100 }]), LONG_PRESS_IDLE);
		assert.deepEqual(run([touchDown, { type: "move", x: 94, y: 108 }]).phase, "armed", "diagonal inside the slop");
	});

	it("a pointercancel before the hold completes disarms", () => {
		assert.deepEqual(run([touchDown, { type: "cancel" }]), LONG_PRESS_IDLE);
	});

	it("once shown, the release and a browser cancel keep the label and the swallow", () => {
		const shown = run([touchDown, { type: "fire" }]);
		assert.deepEqual(longPress(shown, { type: "up" }), shown);
		assert.deepEqual(longPress(shown, { type: "cancel" }), shown);
		assert.deepEqual(longPress(shown, { type: "move", x: 500, y: 500 }), shown, "moving after it shows changes nothing");
	});

	it("the release click is swallowed exactly once", () => {
		const shown = run([touchDown, { type: "fire" }, { type: "up" }]);
		assert.equal(swallowsClick(shown), true);
		const after = longPress(shown, { type: "click" });
		assert.equal(swallowsClick(after), false);
		assert.equal(after.phase, "shown", "the label stays until its own timer");
	});

	it("a fresh press clears a stale swallow — it can never eat a real tap", () => {
		const shown = run([touchDown, { type: "fire" }, { type: "up" }]);
		assert.equal(swallowsClick(longPress(shown, { type: "down", x: 5, y: 5, pointerType: "touch" })), false);
		assert.equal(swallowsClick(longPress(shown, { type: "down", x: 5, y: 5, pointerType: "mouse" })), false);
	});

	it("hide returns to idle", () => {
		assert.deepEqual(run([touchDown, { type: "fire" }, { type: "hide" }]), LONG_PRESS_IDLE);
	});

	it("the browser's long-press menu is suppressed from the touch-down until the label hides", () => {
		assert.equal(ownsContextMenu(LONG_PRESS_IDLE), false);
		assert.equal(ownsContextMenu(run([touchDown])), true, "contextmenu can fire at about the hold time");
		assert.equal(ownsContextMenu(run([touchDown, { type: "fire" }])), true);
		assert.equal(ownsContextMenu(run([touchDown, { type: "fire" }, { type: "hide" }])), false);
	});
});
