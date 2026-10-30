import assert from "node:assert/strict";
import { test } from "node:test";
import { drawerTranslate } from "../components/drawer-swipe.ts";

/** Android phone pass: where the drawer is while a finger drags it. */

test("dragging an open drawer moves it by the finger's offset", () => {
	assert.equal(drawerTranslate("open", -40), "max(-40px, -100%) 0");
	assert.equal(drawerTranslate("open", 0), "max(0px, -100%) 0");
});

test("pulling a closed drawer out from the edge starts from fully hidden", () => {
	assert.equal(drawerTranslate("closed", 0), "min(calc(-100% + 0px), 0px) 0");
	assert.equal(drawerTranslate("closed", 120), "min(calc(-100% + 120px), 0px) 0");
});

test("the drag never carries the drawer past fully open or fully closed", () => {
	// the finger can travel any distance; the CSS bound keeps the panel on its two stops
	assert.match(drawerTranslate("closed", 5000), /^min\(.*, 0px\)/);
	assert.match(drawerTranslate("open", -5000), /^max\(.*, -100%\)/);
});
