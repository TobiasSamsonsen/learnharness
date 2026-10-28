import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { endsOpen, rowPosition } from "../components/swipe-row.tsx";

/** Android phone pass: where a swiped sidebar row sits and whether it ends open. Two actions of 76px = 152px revealed. */

const W = 152;

describe("rowPosition", () => {
	it("follows the finger from closed, never past the revealed width and never to the right of closed", () => {
		assert.equal(rowPosition(false, -40, W), -40);
		assert.equal(rowPosition(false, -400, W), -152);
		assert.equal(rowPosition(false, 30, W), 0);
	});

	it("starts from the open position when the row was already open", () => {
		assert.equal(rowPosition(true, 0, W), -152);
		assert.equal(rowPosition(true, 60, W), -92);
		assert.equal(rowPosition(true, 500, W), 0);
		assert.equal(rowPosition(true, -50, W), -152);
	});
});

describe("endsOpen", () => {
	it("a slow drag opens past the halfway point and not before it", () => {
		assert.equal(endsOpen(false, -80, false, W), true);
		assert.equal(endsOpen(false, -60, false, W), false);
	});

	it("an open row stays open for a small drag back and closes past the halfway point", () => {
		assert.equal(endsOpen(true, 40, false, W), true);
		assert.equal(endsOpen(true, 90, false, W), false);
	});

	it("a committed flick decides by its direction, wherever it ended", () => {
		assert.equal(endsOpen(false, -30, true, W), true);
		assert.equal(endsOpen(true, 30, true, W), false);
	});
});
