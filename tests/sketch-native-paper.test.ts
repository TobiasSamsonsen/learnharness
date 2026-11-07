import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backgroundCss, PAPER_PAD, paperCovers, paperCss, paperTransform } from "../components/sketch/sketch-background.ts";
import { toScreen } from "../components/sketch/view-transform.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

describe("the native-ink paper while the view moves", () => {
	const base = { zoom: 1.5, x: 40, y: -20 };
	const pad = { x: 100, y: 200 };

	it("is drawn for a view shifted by the element's overhang, so its lines fall where the canvas' would", () => {
		const css = paperCss("grid", base, "light", 1, pad.x, pad.y);
		const plain = backgroundCss("grid", { zoom: base.zoom, x: base.x - pad.x / base.zoom, y: base.y - pad.y / base.zoom });
		assert.deepEqual(css, plain);
	});

	it("is the identity at the view it was drawn for (the element stays where its overhang put it)", () => {
		const t = paperTransform(base, base, pad.x, pad.y);
		near(t.x, 0);
		near(t.y, 0);
		near(t.scale, 1);
	});

	it("puts a world point where the view puts it: a pan moves the paper with the ink", () => {
		const view = { zoom: 1.5, x: 100, y: 30 };
		const t = paperTransform(base, view, pad.x, pad.y);
		// the element's top-left is at the canvas' (-pad); after the transform its top-left is at -pad + t - pad... in canvas px:
		const elementLeft = t.x - pad.x;
		const elementTop = t.y - pad.y;
		// the world point at the element's top-left when drawn for `base`
		const w = { x: base.x - pad.x / base.zoom, y: base.y - pad.y / base.zoom };
		const where = toScreen(view, w.x, w.y);
		near(elementLeft, where.x);
		near(elementTop, where.y);
	});

	it("scales about the element's own origin as the zoom changes", () => {
		const view = { zoom: 3, x: base.x, y: base.y };
		const t = paperTransform(base, view, pad.x, pad.y);
		near(t.scale, 2);
		const w = { x: base.x - pad.x / base.zoom, y: base.y - pad.y / base.zoom };
		const where = toScreen(view, w.x, w.y);
		near(t.x - pad.x, where.x);
	});

	it("covers the canvas for a small pan and not once the overhang is used up", () => {
		const w = 400;
		const h = 800;
		const padX = w * PAPER_PAD;
		const padY = h * PAPER_PAD;
		const at = { zoom: 1, x: 0, y: 0 };
		assert.equal(paperCovers(at, at, padX, padY, w, h), true);
		// the view moves 50 world px right: the element moves 50 px left, still covering
		assert.equal(paperCovers(at, { zoom: 1, x: 50, y: 0 }, padX, padY, w, h), true);
		// 120 px (more than the 100 px overhang): the right edge shows bare canvas
		assert.equal(paperCovers(at, { zoom: 1, x: 120, y: 0 }, padX, padY, w, h), false);
		assert.equal(paperCovers(at, { zoom: 1, x: 0, y: -250 }, padX, padY, w, h), false);
	});

	it("stops standing in once the zoom has moved too far", () => {
		const w = 400;
		const h = 800;
		const at = { zoom: 1, x: 0, y: 0 };
		assert.equal(paperCovers(at, { zoom: 1.2, x: 0, y: 0 }, w * PAPER_PAD, h * PAPER_PAD, w, h), true);
		assert.equal(paperCovers(at, { zoom: 2, x: 0, y: 0 }, w * PAPER_PAD, h * PAPER_PAD, w, h), false);
		assert.equal(paperCovers(at, { zoom: 0.5, x: 0, y: 0 }, w * PAPER_PAD, h * PAPER_PAD, w, h), false);
	});
});
