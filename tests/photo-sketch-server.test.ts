/**
 * Photo sketches on the server (M17): a camera photo is normalised before it is parsed (upright, capped), stored as the
 * bytes the camera gave, and read back with its real image type. Real JPEG/PNG bytes are built with photon, as in
 * photo-normalize.test.ts. The data dir is isolated before any server module loads.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { loadPhoton } from "../src/agent/image-processing/photon.mjs";
import { newSketchId, parseSketchPayload, type TurnInput } from "../src/core/index.ts";

// ── the seam, BEFORE any server-module import ───────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-photo-sketch-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { normalizePhotoSketch, persistInputSketch, sniffImageMime, sketchImagesFor } = await import("../src/server/sketches.ts");
const { stores } = await import("../src/server/stores.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const photon = await loadPhoton();
assert.ok(photon, "photon (the image library) loads");

/** A solid image of w x h: red on the left half, blue on the right, so a rotation is visible in the pixels. */
function image(w: number, h: number) {
	const data = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			const left = x < w / 2;
			data[i] = left ? 255 : 0;
			data[i + 1] = 0;
			data[i + 2] = left ? 0 : 255;
			data[i + 3] = 255;
		}
	}
	return new photon!.PhotonImage(data, w, h);
}

/** Insert an APP1 EXIF segment carrying `orientation` right after the JPEG's start-of-image marker. */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
	const tiff = [
		0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian, first IFD at 8
		0x00, 0x01, // one entry
		0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // tag 0x0112, SHORT, count 1, value
		0x00, 0x00, 0x00, 0x00, // no next IFD
	];
	const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0" + the TIFF block
	const length = body.length + 2;
	const segment = [0xff, 0xe1, (length >> 8) & 255, length & 255, ...body];
	return new Uint8Array([...jpeg.slice(0, 2), ...segment, ...jpeg.slice(2)]);
}

const dims = (bytes: Uint8Array) => {
	const img = photon!.PhotonImage.new_from_byteslice(bytes);
	try {
		return { w: img.get_width(), h: img.get_height() };
	} finally {
		img.free();
	}
};

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A raw request body carrying a photo sketch of these bytes (the claimed size is the image's own). */
function photoBody(bytes: Uint8Array, w: number, h: number, mimeType: "image/jpeg" | "image/png" = "image/jpeg") {
	return {
		type: "answer",
		sketch: { id: newSketchId(), producer: "photo", strokes: [], photo: { mimeType, width: w, height: h, data: b64(bytes) } },
	};
}

describe("normalizePhotoSketch", () => {
	it("upright-rotates an EXIF-tagged JPEG photo and the result parses as a photo sketch", async () => {
		const tagged = withOrientation(image(800, 600).get_bytes_jpeg(90), 6);
		const input = photoBody(tagged, 800, 600);
		const out = await normalizePhotoSketch(input);
		assert.equal(out.ok, true);
		if (!out.ok) return;
		const sketch = (out.input as { sketch: { id: string; producer: string; strokes: unknown[]; photo: { mimeType: string; width: number; height: number; data: string } } }).sketch;
		assert.equal(sketch.id, (input.sketch as { id: string }).id, "the sketch keeps its id");
		assert.equal(sketch.producer, "photo");
		assert.deepEqual(sketch.strokes, []);
		const bytes = new Uint8Array(Buffer.from(sketch.photo.data, "base64"));
		assert.equal(sketch.photo.mimeType, sniffImageMime(bytes), "the type is the bytes' real type (PNG when it fits the cap)");
		assert.deepEqual({ w: sketch.photo.width, h: sketch.photo.height }, { w: 600, h: 800 }, "upright, not sideways");
		assert.deepEqual(dims(bytes), { w: 600, h: 800 }, "the bytes agree with the reported size");
		assert.equal(parseSketchPayload(sketch).photo?.width, 600, "the parser accepts the normalised photo");
	});

	it("refuses a photo whose bytes are not an image", async () => {
		const out = await normalizePhotoSketch(photoBody(new TextEncoder().encode("this is not a picture"), 800, 600));
		assert.deepEqual(out, { ok: false, error: "The photo could not be read" });
	});

	it("refuses a photo whose data is over the size limit before decoding it", async () => {
		const input = { type: "answer", sketch: { id: newSketchId(), producer: "photo", strokes: [], photo: { mimeType: "image/jpeg", width: 800, height: 600, data: "A".repeat(8_000_001) } } };
		assert.deepEqual(await normalizePhotoSketch(input), { ok: false, error: "The photo is too large" });
	});

	it("passes a non-photo input through unchanged and never mutates its argument", async () => {
		const input = {
			type: "answer",
			sketch: { id: newSketchId(), producer: "web-canvas", strokes: [{ size: 4, points: [1, 2, 0.5, 3, 4, 0.5, 5, 6, 0.5] }] },
		};
		const snapshot = structuredClone(input);
		const out = await normalizePhotoSketch(input);
		assert.equal(out.ok, true);
		if (out.ok) assert.equal(out.input, input, "the same object comes back");
		assert.deepEqual(input, snapshot, "the argument is untouched");

		const photo = photoBody(image(800, 600).get_bytes_jpeg(90), 800, 600);
		const photoSnapshot = structuredClone(photo);
		const normalized = await normalizePhotoSketch(photo);
		assert.equal(normalized.ok, true);
		assert.deepEqual(photo, photoSnapshot, "a photo's argument is untouched too");

		for (const odd of [null, "text", 42, { type: "dismiss" }]) {
			assert.deepEqual(await normalizePhotoSketch(odd), { ok: true, input: odd });
		}
	});
});

describe("persistInputSketch and sketchImagesFor", () => {
	const CHAT = "photochat";

	it("stores a photo sketch as its own bytes and the model reads them back as a JPEG", async () => {
		const jpeg = image(700, 500).get_bytes_jpeg(90);
		const sketch = parseSketchPayload(photoBody(jpeg, 700, 500).sketch);
		await persistInputSketch(CHAT, { type: "answer", sketch } as unknown as TurnInput);

		const stored = stores.sketchStore.pagePng(CHAT, sketch.id, 0);
		assert.ok(stored);
		assert.equal(b64(stored), b64(jpeg), "the photo's bytes are stored as given");
		assert.equal(stores.sketchStore.strokes(CHAT, sketch.id), JSON.stringify({ producer: "photo" }));
		assert.equal(stores.sketchStore.pageSvg(CHAT, sketch.id, 0)?.includes("<image"), true, "the UI page places the photo");

		const img = sketchImagesFor(CHAT)(sketch.id, 0);
		assert.equal(img?.mimeType, "image/jpeg");
		assert.equal(img?.data, b64(jpeg));
		assert.equal(sketchImagesFor(CHAT)(sketch.id, 1), null, "a photo has one page");
	});

	it("a stroke sketch still renders to a PNG and is read back as image/png", async () => {
		const line = { size: 4, points: [10, 10, 0.5, 200, 40, 0.5, 300, 80, 0.5] };
		const sketch = parseSketchPayload({ id: newSketchId(), producer: "web-canvas", strokes: [line] });
		await persistInputSketch(CHAT, { type: "answer", sketch } as unknown as TurnInput);
		const img = sketchImagesFor(CHAT)(sketch.id, 0);
		assert.equal(img?.mimeType, "image/png");
		assert.equal(Buffer.from(img!.data, "base64")[0], 0x89);
	});
});

describe("sniffImageMime", () => {
	it("tells a JPEG from a PNG by its magic bytes, and defaults to PNG", () => {
		assert.equal(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
		assert.equal(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), "image/png");
		assert.equal(sniffImageMime(new Uint8Array([0xff, 0xd8, 0x00])), "image/png", "two of three JPEG bytes is not a JPEG");
		assert.equal(sniffImageMime(new Uint8Array(0)), "image/png", "empty bytes default to PNG");
		assert.equal(sniffImageMime(new TextEncoder().encode("hello")), "image/png", "unknown bytes default to PNG");
	});
});
