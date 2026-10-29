import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitWithin, PHOTO_MAX_EDGE, PHOTO_MIN_EDGE } from "../components/photo-answer.ts";

/**
 * The pure part of a photo answer (M17): how a photo is scaled before it is sent. The canvas path (preparePhoto) needs a
 * real browser and is not tested here.
 */
describe("fitWithin", () => {
	it("scales a large landscape photo so its long edge is the max, keeping the proportions", () => {
		assert.deepEqual(fitWithin(4000, 3000, PHOTO_MAX_EDGE), { width: 2000, height: 1500 });
	});

	it("scales a large portrait photo by its height", () => {
		assert.deepEqual(fitWithin(3000, 4000, PHOTO_MAX_EDGE), { width: 1500, height: 2000 });
	});

	it("never enlarges a photo that already fits", () => {
		assert.deepEqual(fitWithin(800, 600, PHOTO_MAX_EDGE), { width: 800, height: 600 });
		assert.deepEqual(fitWithin(PHOTO_MAX_EDGE, 1000, PHOTO_MAX_EDGE), { width: PHOTO_MAX_EDGE, height: 1000 });
	});

	it("rounds to whole pixels", () => {
		const r = fitWithin(3001, 2000, 1000);
		assert.equal(r.width, 1000);
		assert.equal(r.height, 666);
		assert.ok(Number.isInteger(r.width) && Number.isInteger(r.height));
	});

	it("keeps every side at least 1 pixel, even for very thin pictures", () => {
		assert.deepEqual(fitWithin(10000, 1, PHOTO_MAX_EDGE), { width: PHOTO_MAX_EDGE, height: 1 });
		const tiny = fitWithin(1, 1, 1);
		assert.deepEqual(tiny, { width: 1, height: 1 });
		assert.ok(fitWithin(5000, 2, 10).height >= 1);
	});

	it("leaves a photo at the minimum edge as it is", () => {
		assert.deepEqual(fitWithin(PHOTO_MIN_EDGE, PHOTO_MIN_EDGE, PHOTO_MAX_EDGE), { width: PHOTO_MIN_EDGE, height: PHOTO_MIN_EDGE });
	});
});
