/**
 * Photo sketch answers (M17) — the pure contract: photo payload validation,
 * the one-page plan, the record's ref, the input events, and the kept page
 * (a photo is never a page the learner draws on). Pen payloads must be
 * unaffected.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	SketchPayloadError,
	inputAppends,
	keptSketchOf,
	newThinkingMessage,
	parseChatInput,
	parseSketchPayload,
	planSketch,
	sketchRefOf,
	type LhMessage,
	type SketchPayload,
	type SketchStroke,
} from "../src/core/index.ts";

/** A straight stroke from (x0, y0) to (x1, y1), `n` samples. */
function line(x0: number, y0: number, x1: number, y1: number, n = 12, size = 4): SketchStroke {
	const points: number[] = [];
	for (let i = 0; i < n; i++) {
		const t = i / (n - 1);
		points.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 0.5);
	}
	return { size, points };
}

const PEN_ID = "sk_penpenpen00000001";
const PHOTO_ID = "sk_photophoto000001";

/** Real magic-number heads: 8 PNG signature bytes, and a JPEG SOI + APP0 marker (12 bytes each, no padding). */
const PNG_DATA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
const JPEG_DATA = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");

/** A raw photo wire payload; `photo` overrides fields of the photo object, `extra` adds top-level fields. */
const photoRaw = (photo: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
	id: PHOTO_ID,
	producer: "photo",
	strokes: [],
	photo: { mimeType: "image/png", width: 800, height: 600, data: PNG_DATA, ...photo },
	...extra,
});

const jpegPayload = parseSketchPayload({
	id: PHOTO_ID,
	producer: "photo",
	strokes: [],
	photo: { mimeType: "image/jpeg", width: 1200, height: 900, data: JPEG_DATA },
});

const penPayload = (strokes: SketchStroke[], id = PEN_ID): SketchPayload => ({ id, producer: "web-canvas", strokes });

describe("parseSketchPayload: photo payloads", () => {
	it("accepts a png photo and returns the photo with no strokes", () => {
		const parsed = parseSketchPayload(photoRaw());
		assert.equal(parsed.producer, "photo");
		assert.deepEqual(parsed.strokes, []);
		assert.deepEqual(parsed.photo, { mimeType: "image/png", width: 800, height: 600, data: PNG_DATA });
	});

	it("accepts a jpeg photo", () => {
		assert.equal(jpegPayload.photo?.mimeType, "image/jpeg");
		assert.equal(jpegPayload.photo?.width, 1200);
	});

	it("accepts an empty strokes array on a photo", () => {
		assert.doesNotThrow(() => parseSketchPayload(photoRaw({}, { strokes: [] })));
	});

	const refusals: [string, unknown, RegExp][] = [
		["a photo with strokes", photoRaw({}, { strokes: [line(0, 0, 10, 10)] }), /no strokes/],
		["a photo with a kept page (newFrom)", photoRaw({}, { newFrom: 0 }), /no kept page/],
		["a photo payload with no photo", { id: PHOTO_ID, producer: "photo", strokes: [] }, /photo is missing/],
		["a gif photo", photoRaw({ mimeType: "image/gif" }), /png or a jpeg/],
		["a non-integer width", photoRaw({ width: 800.5 }), /at most 2000 px/],
		["a width over 2000 px", photoRaw({ width: 2001 }), /at most 2000 px/],
		["a height over 2000 px", photoRaw({ height: 2001 }), /at most 2000 px/],
		["a long edge under 600 px", photoRaw({ width: 400, height: 300 }), /too small to read/],
		["data over 8 MB", photoRaw({ data: "A".repeat(8_000_001) }), /larger than 8 MB/],
		["data that is not base64", photoRaw({ data: "not base64!" }), /invalid or larger than 8 MB/],
		["bytes that do not match a jpeg type", photoRaw({ mimeType: "image/jpeg" }), /do not match its type/],
	];
	for (const [name, raw, message] of refusals) {
		it(`refuses ${name}`, () => {
			assert.throws(() => parseSketchPayload(raw), (err: unknown) => err instanceof SketchPayloadError && message.test((err as Error).message));
		});
	}
});

describe("planSketch: a photo is one page", () => {
	it("plans exactly one page at the photo's size, embedding the image", () => {
		const plan = planSketch(jpegPayload);
		assert.equal(plan.length, 1);
		assert.equal(plan[0]!.width, 1200);
		assert.equal(plan[0]!.height, 900);
		assert.match(plan[0]!.svg, /data:image\/jpeg;base64,/);
	});
});

describe("sketchRefOf: a photo's record", () => {
	it("keeps its page shape, no strokes and no points", () => {
		assert.deepEqual(sketchRefOf(jpegPayload), {
			id: PHOTO_ID,
			producer: "photo",
			pages: [{ width: 1200, height: 900 }],
			strokeCount: 0,
			pointCount: 0,
		});
	});
});

describe("parseChatInput: a photo sketch", () => {
	it("an answer carrying a photo parses and derives the ref", () => {
		const parsed = parseChatInput({
			type: "answer",
			toolCallId: "q1",
			answer: { kind: "explain", text: "" },
			sketch: { id: PHOTO_ID, producer: "photo", strokes: [], photo: jpegPayload.photo },
		});
		assert.equal(parsed.type, "answer");
		if (parsed.type !== "answer") return;
		assert.deepEqual(parsed.answer.sketch, sketchRefOf(jpegPayload));
	});

	it("a thinking input carrying a photo parses and the marker carries the derived ref", () => {
		const problem: LhMessage[] = [
			{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "c1", name: "problem", arguments: { statement: "s" } }], timestamp: 1 } as unknown as LhMessage,
			{ id: "r1", role: "toolResult", toolCallId: "c1", toolName: "problem", content: [{ type: "text", text: "posed" }], isError: false, timestamp: 1 } as unknown as LhMessage,
		];
		const input = parseChatInput({
			type: "thinking",
			problemCallId: "c1",
			text: "",
			sketch: { id: PHOTO_ID, producer: "photo", strokes: [], photo: jpegPayload.photo },
		});
		assert.equal(input.type, "thinking");
		const marker = inputAppends({ messages: problem, kind: "practice" }, input).at(-1);
		assert.deepEqual((marker as { details: { sketch: unknown } }).details.sketch, sketchRefOf(jpegPayload));
	});
});

describe("keptSketchOf: a photo is never the kept page", () => {
	it("ignores a photo ref after the pen sketch and returns the pen sketch", () => {
		const penRef = sketchRefOf(penPayload([line(0, 0, 400, 40)]));
		const photoRef = sketchRefOf(jpegPayload);
		const pose = {
			id: "a-p1",
			role: "assistant",
			content: [{ type: "toolCall", id: "p1", name: "problem", arguments: { statement: "s" } }],
			timestamp: 1,
		} as unknown as AgentMessage;
		const messages = [
			pose,
			newThinkingMessage("p1", "t", penRef) as unknown as AgentMessage,
			newThinkingMessage("p1", "t", photoRef) as unknown as AgentMessage,
		];
		assert.equal(keptSketchOf(messages, "p1")?.id, PEN_ID);
	});
});

describe("pen payloads are unaffected by the photo branch", () => {
	it("a stroke payload parses as before", () => {
		const parsed = parseSketchPayload(penPayload([line(10, 10, 200, 40)]));
		assert.equal(parsed.producer, "web-canvas");
		assert.equal(parsed.strokes.length, 1);
		assert.equal("photo" in parsed, false);
	});

	it("a pen payload with a stray photo field ignores it", () => {
		const raw = { ...penPayload([line(10, 10, 200, 40)]), photo: { mimeType: "image/gif", width: 1, height: 1, data: "!!" } };
		const parsed = parseSketchPayload(raw);
		assert.equal(parsed.producer, "web-canvas");
		assert.equal("photo" in parsed, false);
		assert.equal(sketchRefOf(parsed).strokeCount, 1);
	});
});
