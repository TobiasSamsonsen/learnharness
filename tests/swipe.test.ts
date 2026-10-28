import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSwipeTracker, type SwipeConfig } from "../components/swipe.ts";

/** Android phone pass: the recognizer behind the sidebar, dock and row swipes. Times are in ms, distances in px. */

const left: SwipeConfig = { axis: "x", way: "neg", commitDistance: 80 };

/** Drive a tracker through a path of [x, y] points, `stepMs` apart; returns the tracker and the final move state. */
function drag(cfg: SwipeConfig, points: Array<[number, number]>, stepMs = 16) {
	const tr = createSwipeTracker(cfg);
	const [x0, y0] = points[0]!;
	tr.down(x0, y0, 0);
	let state = tr.state;
	points.slice(1).forEach(([x, y], i) => {
		state = tr.move(x, y, (i + 1) * stepMs);
	});
	return { tr, state };
}

describe("deciding between a swipe and a scroll", () => {
	it("stays pending under the slop", () => {
		const { state } = drag(left, [[200, 300], [195, 301]]);
		assert.equal(state.phase, "pending");
		assert.equal(state.offset, 0);
	});

	it("a mostly horizontal drag in the allowed way becomes an active swipe that follows the finger", () => {
		const { state } = drag(left, [[200, 300], [190, 302], [150, 305]]);
		assert.equal(state.phase, "active");
		assert.equal(state.offset, -50);
	});

	it("a mostly vertical drag is a scroll: rejected, and it stays rejected even if it turns sideways later", () => {
		const { tr, state } = drag(left, [[200, 300], [198, 330]]);
		assert.equal(state.phase, "rejected");
		const later = tr.move(100, 340, 80);
		assert.equal(later.phase, "rejected");
		assert.equal(later.offset, 0);
		assert.equal(tr.up(100).commit, false);
	});

	it("a diagonal drag does not count as a swipe (the axis must dominate)", () => {
		assert.equal(drag(left, [[200, 300], [175, 320]]).state.phase, "rejected");
	});

	it("the wrong way is rejected (a right swipe on a left-only gesture)", () => {
		assert.equal(drag(left, [[200, 300], [240, 301]]).state.phase, "rejected");
	});

	it("a swipe never reports movement against its allowed way", () => {
		const { tr } = drag(left, [[200, 300], [150, 300]]);
		assert.equal(tr.move(230, 300, 100).offset, 0); // finger came back past the start
	});
});

describe("committing on release", () => {
	it("commits past the distance", () => {
		const { tr } = drag(left, [[300, 300], [250, 300], [200, 300], [210, 300]], 200); // slow, ends at -90
		assert.equal(tr.up(700).commit, true);
	});

	it("does not commit a short, slow drag", () => {
		const { tr } = drag(left, [[300, 300], [270, 300], [250, 300]], 200);
		const e = tr.up(600);
		assert.equal(e.commit, false);
		assert.equal(e.offset, -50);
	});

	it("a quick flick commits a shorter swipe", () => {
		const { tr } = drag(left, [[300, 300], [280, 300], [250, 300]], 16); // -50px in 32ms
		assert.equal(tr.up(34).commit, true);
	});

	it("a flick below the minimum distance does not commit", () => {
		const { tr } = drag(left, [[300, 300], [290, 300], [285, 300]], 8);
		assert.equal(tr.up(18).commit, false);
	});

	it("a drag that was rejected never commits", () => {
		const { tr } = drag(left, [[300, 300], [300, 400]], 16);
		assert.equal(tr.up(20).commit, false);
	});

	it("a flick that reverses at the end does not commit", () => {
		const tr = createSwipeTracker(left);
		tr.down(300, 300, 0);
		tr.move(280, 300, 16);
		tr.move(250, 300, 32);
		tr.move(290, 300, 60); // back toward the start, fast
		assert.equal(tr.up(62).commit, false);
	});
});

describe("other axes and ways", () => {
	it("a downward swipe (docks) follows the finger down and commits past its distance", () => {
		const down: SwipeConfig = { axis: "y", way: "pos", commitDistance: 60 };
		const { tr, state } = drag(down, [[200, 100], [202, 130], [204, 190]], 120);
		assert.equal(state.phase, "active");
		assert.equal(state.offset, 90);
		assert.equal(tr.up(400).commit, true);
	});

	it("a rightward edge swipe (open the sidebar) reports a positive offset", () => {
		const right: SwipeConfig = { axis: "x", way: "pos", commitDistance: 72 };
		assert.equal(drag(right, [[4, 400], [40, 404], [90, 406]]).state.offset, 86);
	});

	it("'both' allows either way", () => {
		const both: SwipeConfig = { axis: "x", way: "both", commitDistance: 50 };
		assert.equal(drag(both, [[100, 100], [60, 100]]).state.offset, -40);
		assert.equal(drag(both, [[100, 100], [140, 100]]).state.offset, 40);
	});

	it("cancel resets everything", () => {
		const { tr } = drag(left, [[200, 300], [150, 300]]);
		tr.cancel();
		assert.equal(tr.state.phase, "idle");
		assert.equal(tr.up(10).commit, false);
	});
});
