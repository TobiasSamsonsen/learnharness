/** The camera route and the captured file's name (M17): which way a photo is taken on which device. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAMERA_CONSTRAINTS, cameraRoute, photoFileName } from "../components/camera-capture.ts";

describe("cameraRoute", () => {
	it("the Android shell and phone browsers open the camera app through a capture input", () => {
		assert.equal(cameraRoute({ androidShell: true, coarsePointer: true, hasGetUserMedia: false }), "input");
		assert.equal(cameraRoute({ androidShell: true, coarsePointer: false, hasGetUserMedia: true }), "input", "the shell wins even with a webcam API");
		assert.equal(cameraRoute({ androidShell: false, coarsePointer: true, hasGetUserMedia: true }), "input", "a touch device, not the webcam dialog");
	});

	it("a desktop with a camera API gets the webcam dialog", () => {
		assert.equal(cameraRoute({ androidShell: false, coarsePointer: false, hasGetUserMedia: true }), "dialog");
	});

	it("no way to reach a camera: the entry is not shown", () => {
		assert.equal(cameraRoute({ androidShell: false, coarsePointer: false, hasGetUserMedia: false }), "none");
	});
});

describe("the captured file", () => {
	it("is named by the time, as a jpg, with no characters a path dislikes", () => {
		const name = photoFileName(Date.UTC(2026, 9, 29, 16, 30, 5, 123));
		assert.equal(name, "photo-2026-10-29T16-30-05-123Z.jpg");
		assert.ok(!/[:\/]/.test(name));
		assert.notEqual(photoFileName(1), photoFileName(2), "two photos never collide");
	});

	it("asks the webcam for the back camera when there is one, with no sound", () => {
		assert.equal(CAMERA_CONSTRAINTS.video.facingMode, "environment");
		assert.equal(CAMERA_CONSTRAINTS.audio, false);
	});
});
