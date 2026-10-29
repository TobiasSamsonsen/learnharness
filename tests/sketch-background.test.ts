import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { backgroundCss, backgroundLines, backgroundStep, DEFAULT_PAPER_SIZE, loadPaperSize, nextBackground, PAPER_SIZES, paperSpacing, savePaperSize, SKETCH_BACKGROUNDS } from "../components/sketch/sketch-background.ts";

describe("the canvas paper (a drawing aid, never sent to the model)", () => {
	it("the owner's spacings at zoom 1: grid 32, ruled 40", () => {
		assert.equal(backgroundStep("grid", 1), 32);
		assert.equal(backgroundStep("ruled", 1), 40);
	});

	it("zoomed far out the spacing doubles until the lines are at least 10 px apart", () => {
		assert.equal(backgroundStep("grid", 0.1), 128, "32 x 4 = 128 world = 12.8 px");
		for (const zoom of [0.1, 0.17, 0.3, 0.5, 1, 4, 8]) assert.ok(backgroundStep("grid", zoom) * zoom >= 10, `zoom ${zoom}`);
	});

	it("lines fall where the world's multiples of the step are, and follow the view", () => {
		const home = backgroundLines("grid", { zoom: 1, x: 0, y: 0 }, 100, 70);
		assert.deepEqual(home.xs, [0, 32, 64, 96]);
		assert.deepEqual(home.ys, [0, 32, 64]);
		// panned by 10 world px: the line at 32 is now 22 px in; the one at 0 is off screen (left of -10 is not drawn)
		const panned = backgroundLines("grid", { zoom: 1, x: 10, y: 0 }, 100, 70);
		assert.deepEqual(panned.xs, [-10, 22, 54, 86]);
		const zoomed = backgroundLines("grid", { zoom: 2, x: 0, y: 0 }, 130, 70);
		assert.deepEqual(zoomed.xs, [0, 64, 128]);
	});

	it("ruled paper is horizontal lines only; none draws nothing; an empty canvas draws nothing", () => {
		const ruled = backgroundLines("ruled", { zoom: 1, x: 0, y: 0 }, 100, 90);
		assert.deepEqual(ruled.xs, []);
		assert.deepEqual(ruled.ys, [0, 40, 80]);
		assert.deepEqual(backgroundLines("none", { zoom: 1, x: 0, y: 0 }, 100, 100), { xs: [], ys: [] });
		assert.deepEqual(backgroundLines("grid", { zoom: 1, x: 0, y: 0 }, 0, 100), { xs: [], ys: [] });
	});

	it("negative origins work", () => {
		const v = backgroundLines("grid", { zoom: 1, x: -50, y: -50 }, 100, 100);
		assert.deepEqual(v.xs, [-14, 18, 50, 82]); // world -64, -32, 0, 32 -> screen -14, 18, 50, 82
	});

	it("the CSS for the native surface has the step, and none is empty", () => {
		assert.deepEqual(backgroundCss("none", { zoom: 1, x: 0, y: 0 }), {});
		const css = backgroundCss("grid", { zoom: 2, x: 0, y: 0 });
		assert.equal(css.backgroundSize, "64px 64px, 64px 64px");
		assert.match(String(css.backgroundImage), /linear-gradient/);
		assert.match(String(backgroundCss("dots", { zoom: 1, x: 0, y: 0 }).backgroundImage), /radial-gradient/);
		assert.equal(backgroundCss("ruled", { zoom: 1, x: 0, y: 0 }).backgroundSize, "40px 40px");
	});

	it("the toolbar cycles none, grid, ruled, dots and round again", () => {
		assert.deepEqual(
			SKETCH_BACKGROUNDS.map((k) => nextBackground(k)),
			["grid", "ruled", "dots", "none"],
		);
	});
});

test("the spacing steps scale every paper, and the middle one is today's spacing", () => {
	assert.deepEqual([...PAPER_SIZES], [0.5, 0.75, 1, 1.25, 1.5, 2]);
	assert.equal(PAPER_SIZES[DEFAULT_PAPER_SIZE], 1);
	assert.equal(backgroundStep("grid", 1, 0.5), 16);
	assert.equal(backgroundStep("ruled", 1, 2), 80);
	assert.equal(paperSpacing("grid", 0), 16);
	assert.equal(paperSpacing("ruled", DEFAULT_PAPER_SIZE), 40);
	assert.equal(paperSpacing("dots", 5), 64);
	// a small spacing still doubles when zoomed far out, so lines stay apart
	for (const zoom of [0.1, 0.3, 1, 4]) assert.ok(backgroundStep("grid", zoom, 0.5) * zoom >= 10, `zoom ${zoom}`);
});

test("lines and CSS follow the chosen spacing", () => {
	const view = { zoom: 1, x: 0, y: 0 };
	assert.deepEqual(backgroundLines("grid", view, 40, 40, 0.5).xs, [0, 16, 32]);
	assert.deepEqual(backgroundLines("grid", view, 40, 40).xs, [0, 32]);
	assert.equal(backgroundCss("grid", view, "light", 2).backgroundSize, "64px 64px, 64px 64px");
});

test("the remembered spacing is a valid step, and anything else is the default", () => {
	const store = new Map<string, string>();
	(globalThis as unknown as { localStorage: Storage }).localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
		key: () => null,
		length: 0,
	} as Storage;
	assert.equal(loadPaperSize(), DEFAULT_PAPER_SIZE);
	savePaperSize(4);
	assert.equal(loadPaperSize(), 4);
	for (const bad of ["9", "-1", "1.5", "abc", ""]) {
		store.set("lh:sketch-paper-size", bad);
		assert.equal(loadPaperSize(), DEFAULT_PAPER_SIZE, bad);
	}
});
