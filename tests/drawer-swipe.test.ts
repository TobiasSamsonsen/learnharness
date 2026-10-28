import assert from "node:assert/strict";
import { test } from "node:test";
import { drawerTranslate } from "../components/drawer-swipe.ts";

/** Android phone pass: where the drawer is while a finger drags it. */

test("dragging an open drawer moves it by the finger's offset", () => {
	assert.equal(drawerTranslate("open", -40), "-40px 0");
	assert.equal(drawerTranslate("open", 0), "0px 0");
});

test("pulling a closed drawer out from the edge starts from fully hidden", () => {
	assert.equal(drawerTranslate("closed", 0), "calc(-100% + 0px) 0");
	assert.equal(drawerTranslate("closed", 120), "calc(-100% + 120px) 0");
});
