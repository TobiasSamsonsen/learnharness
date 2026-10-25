/**
 * The course skill map's viewport (owner, 2026-10-25 — the ITGK map laid
 * out 1800 units wide and its text scaled to ~5px in the page column), and
 * the finished mark on a course session's sidebar row.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { initialMapView, MAP_MAX_H, mapFloor, mapViewportHeight, READABLE_ZOOM, SkillMap } from "../components/skill-map.tsx";
import { SessionRow } from "../components/sidebar.tsx";
import type { ChatListItem } from "../src/core/contracts.ts";

describe("the skill map viewport", () => {
	// The real ITGK extent (32 skills, 9 levels, up to 8 on one) at the
	// course page's ~720px column.
	const big = { w: 1816, h: 796 };
	const column = 720;

	it("a large map opens readable — not shrunk to fit — and the viewport stops growing", () => {
		const h = mapViewportHeight(big, column);
		assert.equal(h, MAP_MAX_H);
		const view = initialMapView(big, { w: column, h }, { x: 900, y: 400 });
		assert.equal(view.zoom, READABLE_ZOOM, "≈11px text, where the fit gave ≈5px");
		assert.ok(mapFloor(big, { w: column, h }) < 0.45, "the full fit is still one zoom-out away");
	});

	it("opens centered on the focus, clamped so no blank margin shows past the map", () => {
		const vp = { w: column, h: MAP_MAX_H };
		const mid = initialMapView(big, vp, { x: 900, y: 400 });
		assert.equal(mid.x, column / 2 - 900 * READABLE_ZOOM);
		const leftEdge = initialMapView(big, vp, { x: 10, y: 10 });
		assert.equal(leftEdge.x, 0, "never past the left edge");
		assert.equal(leftEdge.y, 0, "never past the top");
		const rightEdge = initialMapView(big, vp, { x: big.w, y: big.h });
		assert.equal(rightEdge.x, column - big.w * READABLE_ZOOM, "never past the right edge");
		assert.equal(rightEdge.y, MAP_MAX_H - big.h * READABLE_ZOOM);
	});

	it("a small map shows whole, at natural size, in a viewport hugging it", () => {
		const small = { w: 220, h: 160 };
		const h = mapViewportHeight(small, column);
		assert.equal(h, 160 + 16);
		const view = initialMapView(small, { w: column, h }, { x: 0, y: 0 });
		assert.equal(view.zoom, 1, "never blown up past 1:1");
		assert.equal(view.x, (column - 220) / 2, "centered");
	});

	it("renders the viewport and its controls", () => {
		const html = renderToStaticMarkup(
			<SkillMap nodes={[{ id: "a", title: "A" }, { id: "b", title: "B" }]} edges={[{ from: "a", to: "b" }]} statusOf={() => "upcoming"} focusIds={["a"]} />,
		);
		assert.match(html, /data-testid="skill-map"[\s\S]*data-testid="skill-map-viewport"/);
		assert.match(html, /data-testid="plan-node-a"[\s\S]*data-testid="plan-node-b"/);
		assert.match(html, /data-testid="skill-map-fit"[\s\S]*aria-label="Expand the map"[^>]*data-testid="skill-map-expand"/);
		assert.match(html, /Ctrl\+scroll to zoom|Zoom in to pan/);
	});
});

describe("a finished course session in the sidebar", () => {
	const chat = (over: Partial<ChatListItem> = {}): ChatListItem =>
		({
			id: "c1",
			title: "Practice: A",
			createdAt: "2026-10-25T10:00:00Z",
			updatedAt: new Date().toISOString(),
			kind: "practice",
			messageCount: 4,
			phase: "probe",
			pendingQuestion: false,
			pendingProblem: false,
			course: { courseId: "k", mode: "practice", skillIds: ["a"] },
			...over,
		}) as ChatListItem;

	it("says Finished and carries the check mark", () => {
		const html = renderToStaticMarkup(<SessionRow chat={chat({ finished: true })} active={false} onOpen={() => {}} courseTitle="ITGK" />);
		assert.match(html, /ITGK · Finished · just now/);
		assert.match(html, /data-testid="session-finished"/);
	});

	it("an open one does not; a waiting question still outranks finished", () => {
		assert.doesNotMatch(renderToStaticMarkup(<SessionRow chat={chat()} active={false} onOpen={() => {}} />), /Finished|session-finished/);
		assert.match(renderToStaticMarkup(<SessionRow chat={chat({ finished: true, pendingQuestion: true })} active={false} onOpen={() => {}} />), /Waiting for input/);
	});
});
