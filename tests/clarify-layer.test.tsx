import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ClarifyLayer, placeCard } from "../components/clarify-layer.tsx";
import type { ClarifyThread } from "../src/core/contracts/chat.ts";

// placeCard is pure: the limits and the bubble's box are plain numbers. The static render covers the layer's
// first paint only: bubbles need DOM positions, so none may appear before the measuring effects run.

const VIEW = { width: 1000, height: 800 };
const NO_DOCK = { minTop: 100, dockTop: null };

describe("placeCard — where the thread card goes", () => {
	it("sits left of its bubble, 416px wide at most", () => {
		const place = placeCard({ left: 500, top: 300, bottom: 320 }, VIEW, NO_DOCK);
		assert.equal(place.width, 416);
		assert.equal(place.left, 76, "416 wide, 8px short of the bubble's left edge");
		assert.ok(place.left + place.width <= 500 - 8, "the card ends before the bubble");
	});

	it("the width is the viewport less 16px on a narrow screen, and the left is clamped to 8 when there is no room", () => {
		const place = placeCard({ left: 290, top: 300, bottom: 320 }, { width: 300, height: 800 }, NO_DOCK);
		assert.equal(place.width, 284);
		assert.equal(place.left, 8, "no room on the left: clamped to the 8px gutter");
	});

	it("top follows the bubble minus 8, but never above minTop + 8", () => {
		const follows = placeCard({ left: 500, top: 300, bottom: 320 }, VIEW, NO_DOCK);
		assert.equal(follows?.top, 292);
		const clamped = placeCard({ left: 500, top: 110, bottom: 130 }, VIEW, NO_DOCK);
		assert.equal(clamped?.top, 108, "minTop (100) + 8");
	});

	it("top is never lower than limitBottom - 220", () => {
		// limitBottom = 800 - 8 = 792; the bubble sits near the bottom
		const place = placeCard({ left: 500, top: 780, bottom: 800 }, VIEW, NO_DOCK);
		assert.equal(place.top, 792 - 220);
	});

	it("maxHeight is at most 460 and ends 8px above the viewport bottom without a dock", () => {
		const capped = placeCard({ left: 500, top: 300, bottom: 320 }, VIEW, NO_DOCK);
		assert.equal(capped?.maxHeight, 460);
		const bottomed = placeCard({ left: 500, top: 600, bottom: 620 }, VIEW, NO_DOCK);
		assert.equal(bottomed?.top, 572);
		assert.equal(bottomed?.maxHeight, 220);
		assert.equal(bottomed!.top + bottomed!.maxHeight, 800 - 8, "ends 8px above the viewport bottom");
	});

	it("maxHeight ends 8px above the dock top when a dock is given", () => {
		const place = placeCard({ left: 500, top: 300, bottom: 320 }, VIEW, { minTop: 100, dockTop: 600 });
		assert.equal(place.top + place.maxHeight, 600 - 8);
		assert.equal(place.maxHeight, 300);
	});

	it("maxHeight is at least 120, even when less room is left", () => {
		// a tiny viewport: limitBottom - top would be 60
		const place = placeCard({ left: 500, top: 150, bottom: 170 }, { width: 1000, height: 190 }, NO_DOCK);
		assert.equal(place.maxHeight, 120);
	});

	it("a dock with no room above it for a card is ignored: the card only keeps clear of the viewport bottom (keyboard up)", () => {
		// keyboard up: viewport 464 tall, the dock sits at 232, only ~118px above it from minTop 98
		const place = placeCard({ left: 500, top: 397, bottom: 441 }, { width: 1000, height: 464 }, { minTop: 98, dockTop: 232 });
		assert.equal(place.top, 464 - 8 - 220, "pinned 220px above the viewport bottom");
		assert.equal(place.top + place.maxHeight, 464 - 8, "ends above the keyboard");
	});

	it("a dock with room for a card is respected", () => {
		const place = placeCard({ left: 500, top: 300, bottom: 320 }, VIEW, { minTop: 100, dockTop: 700 });
		assert.equal(place.top + place.maxHeight, 700 - 8);
	});

	it("a bubble inside the dock (question wording) gets the full card height above the dock, not the minimum", () => {
		const place = placeCard({ left: 500, top: 750, bottom: 770 }, VIEW, { minTop: 100, dockTop: 700 });
		assert.equal(place.top + place.maxHeight, 700 - 8, "ends above the dock");
		assert.ok(place.maxHeight > 220, "taller than the minimum card");
	});

	it("a tall dock (little room above it): the card still goes above the dock with the room there is, never over the question", () => {
		// the real phone: dock top 320, transcript top 95 → ~209px of room, less than the 220 a card normally wants
		const place = placeCard({ left: 344, top: 414, bottom: 458 }, { width: 430, height: 933 }, { minTop: 95, dockTop: 320 });
		assert.equal(place.top + place.maxHeight, 320 - 8, "ends right above the dock");
		assert.equal(place.bottom, 933 - (320 - 8), "stands on the dock, whatever the card's height, instead of floating above a gap");
		assert.equal(place.maxHeight, 320 - 8 - (95 + 8), "takes the room there is");
		assert.ok(place.top >= 95 + 8, "inside the scroller");
	});

	it("a bubble in the dock with no usable room above it (keyboard up) falls back to clearing the keyboard", () => {
		const place = placeCard({ left: 344, top: 300, bottom: 344 }, { width: 430, height: 464 }, { minTop: 95, dockTop: 200 });
		assert.equal(place.top + place.maxHeight, 464 - 8, "89px of room is under the floor: the card only clears the keyboard");
	});

	it("never returns null: a bubble scrolled out of view or behind the dock pins the card to the nearest edge of the visible area", () => {
		const above = placeCard({ left: 500, top: 50, bottom: 100 }, VIEW, NO_DOCK);
		assert.equal(above.top, 108, "pinned under minTop + 8");
		const below = placeCard({ left: 500, top: 900, bottom: 920 }, VIEW, NO_DOCK);
		assert.equal(below.top, 800 - 8 - 220, "pinned above the viewport bottom");
	});
});

describe("ClarifyLayer — the first paint", () => {
	const thread: ClarifyThread = {
		id: "t1",
		anchor: { messageId: "m1", text: "The inner planets", occurrence: 0 },
		quote: "The inner planets",
		startedAt: "2026-11-02T10:00:00.000Z",
		entries: [],
	};

	it("renders the layer wrapper, excluded from Find, with no card and no bubbles before measuring", () => {
		const html = renderToStaticMarkup(
			<ClarifyLayer
				threads={[thread]}
				busyKey={null}
				error={null}
				ask={async () => null}
				draft={null}
				onDraftDone={() => {}}
			/>,
		);
		assert.ok(html.includes('data-testid="clarify-layer"'), "the layer wrapper");
		assert.ok(html.includes("data-session-find-exclude"), "excluded from Find");
		assert.equal(html.includes('data-testid="clarify-card"'), false, "no card");
		assert.equal(html.includes("data-clarify-bubble"), false, "no bubbles until the anchors are measured");
	});
});
