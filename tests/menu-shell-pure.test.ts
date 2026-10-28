import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMenuPlacement, type MenuSide } from "../components/menu-shell.tsx";

/**
 * The shared menu shell's placement decision (fix wave chunk B): the
 * pure math behind every dropdown's anchoring — side preference, the
 * honest-fit flip, the 60vh cap, alignment. The DOM effects (portal,
 * measure-then-show, re-placement on scroll/resize) are live-verified;
 * this pins the geometry.
 */

const rect = (top: number, bottom: number) => ({ top, bottom, left: 100, right: 300 });
const viewport = (height: number) => ({ width: 1280, height });

describe("computeMenuPlacement — side", () => {
	it("keeps the preferred side when it shows the whole menu", () => {
		for (const preferred of ["up", "down"] as MenuSide[]) {
			const p = computeMenuPlacement(rect(400, 440), viewport(800), 300, preferred, "right");
			assert.equal(p.side, preferred);
		}
	});

	it("flips when the preferred side cannot hold the content and the other is roomier", () => {
		// Anchor 30px above the viewport bottom: down has ~2px of room,
		// up has ~380. A 300px menu must flip UP despite preferring down.
		const p = computeMenuPlacement(rect(770, 800), viewport(800), 300, "down", "right");
		assert.equal(p.side, "up");
		// ...and mirrors: an anchor at the very top preferring up flips down.
		const q = computeMenuPlacement(rect(0, 30), viewport(800), 300, "up", "right");
		assert.equal(q.side, "down");
	});

	it("stays put when neither side fits better (the roomier side already preferred)", () => {
		// Short viewport: down has 450, up has 200 — a 600px menu stays
		// down (capped gracefully) because up is NOT roomier.
		const p = computeMenuPlacement(rect(150, 190), viewport(650), 600, "down", "right");
		assert.equal(p.side, "down");
	});

	it("nothing measured yet (contentHeight ≤ 0) keeps the preferred side", () => {
		const p = computeMenuPlacement(rect(770, 800), viewport(800), 0, "down", "right");
		assert.equal(p.side, "down");
	});
});

describe("computeMenuPlacement — cap + position", () => {
	it("caps at 60vh when the side has more room than that", () => {
		// Anchor high: 648px below it — more than 60vh(480) → the cap is 60vh.
		const p = computeMenuPlacement(rect(100, 140), viewport(800), 300, "down", "right");
		assert.equal(p.maxHeight, 0.6 * 800);
		assert.equal(p.style.top, 144); // anchor bottom + GAP(4)
		assert.equal(p.style.right, 1280 - 300); // right-aligned to the anchor
	});

	it("caps at the side's available room when 60vh exceeds it", () => {
		// Anchor at 500/800: down room = 800 − 8 − 544 = 248 < 480. The
		// short content (100) fits down — no flip — so the cap binds at 248.
		const p = computeMenuPlacement(rect(500, 540), viewport(800), 100, "down", "right");
		assert.equal(p.side, "down");
		assert.equal(p.maxHeight, 248);
	});

	it("never crushes below the usability floor, even against a tiny side", () => {
		// Anchor 30px above the bottom, both sides thin: capped to the
		// floor, not a 2px sliver — the cap overflows rather than crushes.
		const p = computeMenuPlacement(rect(30, 60), viewport(90), 300, "down", "right");
		assert.equal(p.maxHeight, 96);
	});

	it("up-side menus anchor their BOTTOM above the anchor's top", () => {
		const p = computeMenuPlacement(rect(400, 440), viewport(800), 300, "up", "right");
		assert.equal(p.style.bottom, 800 - 400 + 4); // viewport − anchor.top − GAP
		assert.ok(!("top" in p.style));
	});

	it("left alignment keys off the anchor's left edge", () => {
		const p = computeMenuPlacement(rect(400, 440), viewport(800), 300, "down", "left");
		assert.equal(p.style.left, 100);
		assert.ok(!("right" in p.style));
	});
});

describe("computeMenuPlacement — width (a menu never leaves the screen sideways)", () => {
	// a 412px phone; the Sources control sits near the left: its rect is x 30..140
	const phone = { width: 412, height: 800 };
	const near = { top: 700, bottom: 740, left: 30, right: 140 };

	it("without a measured width the anchor edge alone decides (the old behavior)", () => {
		const p = computeMenuPlacement(near, phone, 300, "up", "right");
		assert.equal(p.style.right, 412 - 140);
	});

	it("a right-aligned 320px menu that would cross the left edge is held at the edge floor", () => {
		// right-aligned at x=140 a 320px menu would start at -180
		const p = computeMenuPlacement(near, phone, 300, "up", "right", 320);
		assert.equal(p.style.left, 8);
		assert.ok(!("right" in p.style));
	});

	it("a left-aligned menu that would cross the right edge is held at the right edge floor", () => {
		const p = computeMenuPlacement({ top: 700, bottom: 740, left: 300, right: 400 }, phone, 300, "up", "left", 320);
		assert.equal(p.style.right, 8);
		assert.ok(!("left" in p.style));
	});

	it("a menu that fits keeps its anchor edge", () => {
		const roomy = { top: 700, bottom: 740, left: 100, right: 400 };
		assert.equal(computeMenuPlacement(roomy, phone, 300, "up", "right", 320).style.right, 12);
		assert.equal(computeMenuPlacement({ top: 700, bottom: 740, left: 20, right: 100 }, phone, 300, "up", "left", 320).style.left, 20);
	});

	it("a menu wider than the screen is capped to the screen and flush to the left", () => {
		const p = computeMenuPlacement(near, { width: 300, height: 800 }, 300, "up", "right", 500);
		assert.equal(p.maxWidth, 300 - 16);
		assert.equal(p.style.left, 8);
	});

	it("the cap is the viewport minus the edge floor on both sides", () => {
		assert.equal(computeMenuPlacement(near, phone, 300, "up", "right", 0).maxWidth, 412 - 16);
	});
});

describe("computeMenuPlacement — the system bars", () => {
	it("an up-menu keeps clear of the status bar", () => {
		// anchor 300px from the top, status bar 48px: room = 300 - 4 - (8 + 48)
		const p = computeMenuPlacement({ top: 300, bottom: 340, left: 100, right: 300 }, { width: 412, height: 800 }, 100, "up", "right", 0, { top: 48, bottom: 0 });
		assert.equal(p.maxHeight, 240);
	});

	it("a down-menu keeps clear of the gesture bar", () => {
		const p = computeMenuPlacement({ top: 500, bottom: 540, left: 100, right: 300 }, { width: 412, height: 800 }, 100, "down", "right", 0, { top: 0, bottom: 24 });
		assert.equal(p.maxHeight, 800 - 32 - 544);
	});

	it("no insets behaves exactly as before", () => {
		const a = computeMenuPlacement(rect(500, 540), viewport(800), 100, "down", "right");
		const b = computeMenuPlacement(rect(500, 540), viewport(800), 100, "down", "right", 0, { top: 0, bottom: 0 });
		assert.deepEqual(a, b);
	});
});
