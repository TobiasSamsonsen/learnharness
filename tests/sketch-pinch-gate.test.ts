/** The pinch gate (owner, 2026-10-31): a resting palm must not zoom the sketch view. Numbers are from the Tab S10+ logs. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBigContact, isPalmContact, PALM_ALWAYS_PX, PALM_SHAPE_PX, PINCH_EASE_MS, PINCH_SETTLE_BIG_MS, PINCH_SETTLE_MS, PinchTracker, pinchReady } from "../components/sketch/pinch-gate.ts";
import { moveTap, startTap } from "../components/sketch/tap-gesture.ts";

describe("big contact", () => {
	it("passes the fingertips of the deliberate pinches (4-7.5 px, roughly square, first reports 0.5 x 1)", () => {
		for (const [w, h] of [[4.5, 6], [4, 4], [4.5, 5.5], [3.5, 5.5], [5.5, 5.5], [6.5, 6.5], [7.5, 7.5], [7, 7], [0.5, 1], [1.5, 2], [2, 3]]) {
			assert.equal(isBigContact(w, h), false, `${w}x${h}`);
		}
	});

	it("passes the moving fingertips of the native-ink log (2026-11-06): taller than wide, but fingers", () => {
		// 45 of the 50 palm flags in that log were 2.5x5 (34), 3x5.5 (10) or 2.5x6 (1) on plain fingers; 22 ended a pinch in progress
		for (const [w, h] of [[2.5, 5], [3, 5.5], [2.5, 6]]) {
			assert.equal(isBigContact(w, h), false, `${w}x${h}`);
		}
	});

	it("flags the big contacts of the logs: the palm fragments AND the thumb that lies down in a wide pinch", () => {
		// size alone cannot tell them apart (see 'a palm is a big contact in a cluster'): that is decided by their company
		for (const [w, h] of [[6, 12], [9, 11.5], [6.5, 15], [19, 26.5], [10, 18], [6.5, 10], [8, 9.5], [4.5, 9], [8.5, 10], [9.5, 44.5], [6.5, 12.5], [5, 11], [7, 10.5]]) {
			assert.equal(isBigContact(w, h), true, `${w}x${h}`);
		}
	});

	it("takes either side of the patch, and treats a missing size as small", () => {
		assert.equal(isBigContact(PALM_SHAPE_PX, 1), true);
		assert.equal(isBigContact(1, PALM_SHAPE_PX), true);
		assert.equal(isBigContact(undefined, undefined), false);
		assert.equal(isBigContact(Number.NaN, 4), false);
	});
});

describe("a palm is a big contact in a cluster, or a huge one", () => {
	it("a lone big contact is not a palm (the thumb of a wide pinch: 9-12.5 px in the log)", () => {
		for (const peak of [9, 10.5, 12.5, PALM_ALWAYS_PX - 0.5]) assert.equal(isPalmContact(peak, false), false, `${peak}`);
	});

	it("a big contact that was down with three or more touches is a palm", () => {
		for (const peak of [9, 10, 12]) assert.equal(isPalmContact(peak, true), true, `${peak}`);
		assert.equal(isPalmContact(8.5, true), false, "a small fragment of a cluster is judged by the cluster's size rule, not here");
	});

	it("a huge contact is a palm alone (11.5x14, 9.5x15.5, 20x35 in the log)", () => {
		for (const peak of [14, 15.5, 35]) assert.equal(isPalmContact(peak, false), true, `${peak}`);
	});
});

describe("when two touches may pinch", () => {
	const settled = (n: number) => Array.from({ length: n }, () => ({ downAt: 0, palm: false }));
	const later = PINCH_SETTLE_MS + 1;

	it("needs exactly two touches", () => {
		assert.equal(pinchReady(settled(1), later), false);
		assert.equal(pinchReady(settled(2), later), true);
		assert.equal(pinchReady(settled(3), later), false, "a third touch (a palm beside two fingers) ends the pinch");
		assert.equal(pinchReady(settled(0), later), false);
	});

	it("waits for both touches to settle", () => {
		assert.equal(pinchReady(settled(2), PINCH_SETTLE_MS - 1), false);
		assert.equal(pinchReady([{ downAt: 0, palm: false }, { downAt: 60, palm: false }], PINCH_SETTLE_MS + 30), false, "the later touch is still new");
		assert.equal(pinchReady([{ downAt: 0, palm: false }, { downAt: 60, palm: false }], 60 + PINCH_SETTLE_MS), true);
	});

	it("refuses a pair with a palm", () => {
		assert.equal(pinchReady([{ downAt: 0, palm: false }, { downAt: 0, palm: true }], later), false);
	});
});

describe("PinchTracker", () => {
	/** Two fingertips landed at t=0, 100 px apart on a row. */
	const twoFingers = () => {
		const g = new PinchTracker();
		g.down(1, 100, 100, 4, 4, 0);
		g.down(2, 200, 100, 4, 4, 0);
		return g;
	};
	const settled = PINCH_SETTLE_MS + 80;

	it("opens with a step that changes nothing: the page is where the fingers landed", () => {
		const g = twoFingers();
		const first = g.move(2, 220, 100, 4, 4, settled);
		assert.ok(first?.prev);
		assert.deepEqual(first.next, first.prev, "no jump on the first ready move");
		assert.equal(first.next.dist, 100, "the landing pair: 100 px apart");
		assert.equal(first.next.mx, 150);
		assert.equal(g.pinching, true);
	});

	it("a pair that did not land together (a third touch lifted) opens with a bare baseline: nothing to catch up", () => {
		const g = new PinchTracker();
		g.down(1, 100, 100, 4, 4, 0);
		g.down(2, 200, 100, 4, 4, 0);
		g.down(3, 300, 300, 4, 4, 0);
		g.up(3);
		const first = g.move(2, 220, 100, 4, 4, settled);
		assert.ok(first);
		assert.equal(first.prev, null, "the first ready move only sets the baseline");
		assert.equal(first.next.dist, 120);
		const second = g.move(2, 260, 100, 4, 4, settled + 16);
		assert.equal(second?.prev?.dist, 120);
		assert.equal(second?.next.dist, 160);
	});

	it("starts from where the fingers landed and pays the motion made while waiting back over the ease, losing none", () => {
		const g = twoFingers(); // landed at t=0: midpoint x 150, 100 px apart
		const frames = [
			g.move(2, 230, 100, 4, 4, PINCH_SETTLE_MS), // the gate opens: the fingers are already 30 px apart wider and the midpoint has moved 15
			g.move(2, 260, 100, 4, 4, PINCH_SETTLE_MS + PINCH_EASE_MS / 2),
			g.move(2, 260, 100, 4, 4, PINCH_SETTLE_MS + PINCH_EASE_MS),
			g.move(2, 260, 100, 4, 4, PINCH_SETTLE_MS + PINCH_EASE_MS + 50),
		];
		assert.ok(frames.every((f) => f?.prev));
		const steps = frames.map((f) => f!);
		const open = steps[0]!, half = steps[1]!, full = steps[2]!, after = steps[3]!;
		assert.deepEqual(open.next, open.prev);
		assert.ok(half.next.mx > 150 && half.next.mx < 180, "halfway: the page has caught up part of the way");
		assert.ok(half.next.dist > 100 && half.next.dist < 160);
		assert.equal(full.next.mx, 180, "after the ease the page is exactly where the fingers are");
		assert.equal(full.next.dist, 160);
		assert.deepEqual(after.next, { mx: 180, my: 100, dist: 160 });
		// no travel is lost: the steps add up to everything the fingers did since they landed
		let dx = 0;
		let ratio = 1;
		for (const f of [open, half, full, after]) {
			dx += f.next.mx - f.prev!.mx;
			ratio *= f.next.dist / f.prev!.dist;
		}
		assert.ok(Math.abs(dx - 30) < 1e-9, `${dx}`);
		assert.ok(Math.abs(ratio - 1.6) < 1e-9, `${ratio}`);
	});

	it("waiting for the settle keeps the landing, so a move before it opens nothing and the next one still catches up", () => {
		const g = twoFingers();
		assert.equal(g.move(2, 210, 100, 4, 4, PINCH_SETTLE_MS - 20), null);
		const open = g.move(2, 230, 100, 4, 4, PINCH_SETTLE_MS);
		assert.ok(open?.prev);
		assert.equal(open.next.mx, 150, "still the landing");
	});

	it("a palm that landed with the pair ends its chance of a catch-up: the pair that follows lands afresh", () => {
		const g = new PinchTracker();
		g.down(1, 100, 100, 4, 4, 0);
		g.down(2, 200, 100, 12, 14, 0); // huge: a palm
		g.up(2);
		g.down(3, 400, 100, 4, 4, 100); // a new pair, 1 and 3, lands together here
		const open = g.move(3, 410, 100, 4, 4, 100 + PINCH_SETTLE_MS);
		assert.ok(open?.prev);
		assert.equal(open.next.mx, 250, "the catch-up starts from the NEW pair's landing, not the old one");
		assert.ok(Math.abs(open.next.dist - 300) < 1e-9, `${open.next.dist}`);
	});

	it("waits for both fingers to settle before the baseline", () => {
		const g = twoFingers();
		assert.equal(g.move(2, 210, 100, 4, 4, PINCH_SETTLE_MS - 1), null);
		assert.equal(g.pinching, false);
		assert.ok(g.move(2, 215, 100, 4, 4, PINCH_SETTLE_MS));
	});

	it("keeps pinching while a fingertip stretches to the shapes measured on the tablet (a pan with a wide gap)", () => {
		const g = twoFingers();
		g.move(2, 220, 100, 4, 4, settled); // baseline
		let t = settled;
		for (const [w, h] of [[2.5, 5], [3, 5.5], [2.5, 6]]) {
			t += 16;
			const frame = g.move(1, 100, 100 + t / 10, w, h, t);
			assert.ok(frame?.prev, `${w}x${h} must not end the pinch`);
		}
		assert.equal(g.pinching, true);
	});

	it("a thumb that lies down in a wide pinch (6.5x12.5 in the log) still pinches, landing big or growing mid-pinch", () => {
		const landsBig = new PinchTracker();
		landsBig.down(1, 100, 100, 4, 4, 0);
		landsBig.down(2, 400, 100, 6.5, 12.5, 0);
		assert.equal(landsBig.move(1, 101, 100, 4, 4, settled), null, "a pair with a big contact waits longer to open");
		assert.ok(landsBig.move(1, 102, 100, 4, 4, PINCH_SETTLE_BIG_MS), "two touches, one big: a thumb");

		const grows = twoFingers();
		grows.move(2, 220, 100, 4, 4, settled); // baseline
		for (const [w, h] of [[5, 9], [6.5, 11], [6.5, 12.5]]) {
			const frame = grows.move(2, 260, 100, w, h, settled + 16);
			assert.ok(frame?.prev, `${w}x${h} must not end the pinch`);
		}
		assert.equal(grows.pinching, true);
	});

	it("a pair with a big contact opens only after the longer wait, an ordinary pair keeps the quick start", () => {
		const ordinary = twoFingers();
		assert.ok(ordinary.move(2, 210, 100, 4, 4, PINCH_SETTLE_MS), "fingertips open at the ordinary settle");
		const big = new PinchTracker();
		big.down(1, 100, 100, 4, 4, 0);
		big.down(2, 200, 100, 5, 10, 0); // a lying thumb: 10 px long
		assert.equal(big.move(2, 210, 100, 5, 10, PINCH_SETTLE_MS), null);
		assert.equal(big.move(2, 211, 100, 5, 10, PINCH_SETTLE_BIG_MS - 1), null);
		assert.ok(big.move(2, 212, 100, 5, 10, PINCH_SETTLE_BIG_MS), "a big contact waits PINCH_SETTLE_BIG_MS");
	});

	it("a slow palm (a heel and a finger alone for 150 ms before the fragments come, 2026-11-06) never opens a pinch", () => {
		const g = new PinchTracker();
		g.down(1, 100, 100, 5.5, 7, 0); // the heel lands ...
		g.down(2, 200, 100, 4, 5.5, 80); // ... a finger 80 ms later
		g.move(1, 100, 100, 10, 12, 90); // the heel's patch grows to 10.5x12 within 70 ms
		assert.equal(g.move(2, 205, 100, 4, 5.5, 160), null, "ordinary settle has passed, but a big contact is in the pair");
		assert.equal(g.pinching, false);
		g.down(3, 150, 120, 0.5, 0.5, 230); // the fragments arrive 150 ms after the finger
		g.down(4, 160, 130, 0.5, 0.5, 230);
		assert.equal(g.touches.get(1)?.palm, true, "four touches: the heel is part of a palm cluster");
		assert.equal(g.move(2, 210, 100, 4, 5.5, 500), null);
		g.up(3);
		g.up(4);
		assert.equal(g.move(2, 215, 100, 4, 5.5, 900), null, "the heel stays a palm after the fragments lift");
	});

	it("a huge contact ends the pinch, and stays a palm until it lifts", () => {
		const g = twoFingers();
		g.move(2, 220, 100, 4, 4, settled);
		assert.equal(g.move(1, 100, 100, 14, 16, settled + 16), null, "14 px or more is a palm on its own");
		assert.equal(g.pinching, false);
		assert.equal(g.move(1, 100, 100, 3, 3, settled + 32), null, "sticky: shrinking back does not reopen it");
		g.up(1);
		g.down(3, 100, 100, 4, 4, settled + 40);
		assert.equal(g.move(3, 100, 100, 4, 4, settled + 50), null, "the new finger is still settling");
		assert.ok(g.move(3, 100, 100, 4, 4, settled + 40 + PINCH_SETTLE_MS), "the pinch resumes with two fingers again");
	});

	it("a palm's small first report (3.5x7 in the log, before it grew to 9.5x44.5) is not a palm yet, but the sticky flag holds it once it grows", () => {
		const g = new PinchTracker();
		g.down(1, 100, 100, 4, 4, 0);
		g.down(2, 200, 100, 3.5, 7, 0);
		assert.ok(g.move(1, 101, 100, 4, 4, settled), "the small first report passes (the settle window and the touch count guard it)");
		assert.equal(g.move(2, 200, 100, 9.5, 44.5, settled + 16), null, "once it grows it is a palm");
		assert.equal(g.move(2, 200, 100, 3.5, 7, settled + 32), null, "and stays one");
	});

	it("a touch that lands huge never pinches, even beside one finger", () => {
		const g = new PinchTracker();
		g.down(1, 100, 100, 4, 4, 0);
		g.down(2, 200, 100, 12, 14, 0);
		assert.equal(g.move(1, 101, 100, 4, 4, settled), null);
	});

	it("a palm cluster is refused while it is down, and its big remnant stays a palm after the fragments lift", () => {
		const g = new PinchTracker();
		// the 2026-11-06 log: a palm lands as several touches, the biggest 9-12 px
		g.down(1, 100, 100, 6.5, 10, 0);
		g.down(2, 150, 120, 3, 3, 10);
		g.down(3, 160, 130, 3, 3, 15);
		g.down(4, 300, 200, 4, 4, 20); // a finger of the other hand
		assert.equal(g.move(4, 301, 200, 4, 4, settled), null, "four touches never pinch");
		g.up(2); // the system takes the small fragments back
		g.up(3);
		assert.equal(g.move(4, 302, 200, 4, 4, PINCH_SETTLE_BIG_MS + 100), null, "the palm remnant (6.5x10, tagged by the cluster) still blocks the pair, long after both settled");
		assert.equal(g.pinching, false);
	});

	it("the cluster tag is retroactive: a palm that landed alone and grew before its company came is caught", () => {
		const g = new PinchTracker();
		g.down(1, 100, 100, 5, 7.5, 0); // id 175 in the log: lands alone ...
		g.move(1, 100, 100, 6.5, 10, 30); // ... grows to a big contact, still alone: not a palm yet
		assert.equal(g.touches.get(1)?.palm, false);
		g.down(2, 150, 120, 3.5, 3.5, 40);
		g.down(3, 160, 130, 3, 3, 50);
		assert.equal(g.touches.get(1)?.palm, false, "three touches are not yet a cluster");
		g.down(4, 300, 200, 4, 4, 60); // the fourth touch forms the cluster
		assert.equal(g.touches.get(1)?.palm, true, "now the early big contact counts as part of it");
		g.up(2);
		g.up(3);
		assert.equal(g.move(4, 301, 200, 4, 4, PINCH_SETTLE_BIG_MS + 100), null);
	});

	it("a stray third touch (2x3.5 for 113 ms in the log) pauses a thumb's pinch but does not make the thumb a palm", () => {
		const g = twoFingers();
		g.move(1, 100, 100, 6.5, 11, 10); // a big (thumb) patch beside one finger
		assert.ok(g.move(2, 205, 100, 4, 4, PINCH_SETTLE_BIG_MS), "the pair opens after the longer wait");
		g.down(9, 500, 500, 2, 3.5, PINCH_SETTLE_BIG_MS + 20); // a stray touch makes it three
		assert.equal(g.pinching, false, "three touches never pinch");
		assert.equal(g.move(2, 206, 100, 4, 4, PINCH_SETTLE_BIG_MS + 60), null);
		g.up(9);
		assert.equal(g.touches.get(1)?.palm, false, "three touches are not a palm cluster: the thumb is still a thumb");
		assert.ok(g.move(2, 210, 100, 4, 4, PINCH_SETTLE_BIG_MS + 400), "the pinch resumes once the stray touch is gone");
	});

	it("two strays make four touches, a cluster: the big thumb present then is a palm (the documented cost)", () => {
		const g = twoFingers();
		g.move(1, 100, 100, 6.5, 11, 10);
		g.down(8, 500, 500, 2, 3.5, 50);
		g.down(9, 520, 500, 2, 3.5, 60);
		assert.equal(g.touches.get(1)?.palm, true);
	});

	it("a finger that lands after a cluster has ended is not tagged by it", () => {
		const g = new PinchTracker();
		g.down(1, 100, 100, 4, 4, 0);
		g.down(2, 150, 120, 3, 3, 0);
		g.down(3, 300, 200, 4, 4, 0);
		g.down(5, 320, 210, 4, 4, 0); // cluster: 1, 2, 3, 5 tagged
		g.up(2);
		g.up(3);
		g.up(5);
		g.down(4, 300, 200, 6.5, 12.5, 100); // later, a thumb with a big patch beside finger 1
		assert.equal(g.touches.get(4)?.palm, false);
		assert.ok(g.move(4, 301, 200, 6.5, 12.5, 100 + PINCH_SETTLE_BIG_MS), "the new pair pinches (after the big-contact wait)");
	});

	it("a third touch ends the pinch", () => {
		const g = twoFingers();
		g.move(2, 220, 100, 4, 4, settled);
		g.down(3, 150, 300, 3, 3, settled + 10);
		assert.equal(g.pinching, false, "down starts a fresh baseline");
		assert.equal(g.move(1, 101, 100, 4, 4, settled + 20), null);
		assert.equal(g.move(1, 102, 100, 4, 4, settled + 400), null, "three fingers never pinch, settled or not");
	});

	it("a lift or a system cancel starts a fresh baseline", () => {
		const g = twoFingers();
		g.move(2, 220, 100, 4, 4, settled);
		g.up(2);
		assert.equal(g.pinching, false);
		g.down(4, 400, 100, 4, 4, settled + 20);
		const frame = g.move(4, 410, 100, 4, 4, settled + 20 + PINCH_SETTLE_MS);
		assert.ok(frame?.prev);
		assert.deepEqual(frame.next, frame.prev, "opens at the NEW pair's landing: no jump from the old pair");
		assert.equal(frame.next.mx, 250);
	});

	it("moving a finger never changes the records the two-finger tap captured where the fingers landed", () => {
		const g = twoFingers();
		const tap = startTap(0, g.touches);
		g.move(2, 300, 100, 4, 4, settled); // a 100 px spread: a pinch, not a tap
		assert.equal(moveTap(tap, g.touches).cancelled, true);
		assert.equal(tap.starts.get(2)?.x, 200, "the landing position is a snapshot");
	});

	it("ignores a finger it never saw, and exposes the fingers for the two-finger tap", () => {
		const g = twoFingers();
		assert.equal(g.move(99, 5, 5, 4, 4, settled), null);
		assert.equal(g.has(1), true);
		assert.equal(g.has(99), false);
		assert.deepEqual([...g.touches.keys()], [1, 2]);
		assert.equal(g.touches.get(1)?.x, 100);
		g.reset();
		assert.equal(g.touches.size, 2, "reset only forgets the baseline");
	});
});
