/**
 * Live dictation piece sizing (Android plan M7b — src/core/dictation-pieces.ts):
 * the env parsers, the splitter behind the adapter's hard cap, and the
 * segmenter taking its limits from the server.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseMaxRequestSeconds, parsePieceSeconds, splitPcm } from "../src/core/dictation-pieces.ts";
import { createSegmenter } from "../components/dictation-live.ts";

// config.ts reads LH_DATA_DIR at module load
process.env.LH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pieces-"));
const { sttPieceLimits } = await import("../src/server/stt-local.ts");

const RATE = 16000;
/** `seconds` of PCM: loud everywhere except the listed quiet windows (in seconds, [from, to)). */
function pcm(seconds: number, quietWindows: Array<[number, number]> = []): Uint8Array {
	const out = new Int16Array(Math.round(seconds * RATE));
	for (let i = 0; i < out.length; i++) {
		const t = i / RATE;
		const quiet = quietWindows.some(([a, b]) => t >= a && t < b);
		out[i] = quiet ? 5 : i % 2 ? 9000 : -9000;
	}
	return new Uint8Array(out.buffer);
}
const seconds = (b: Uint8Array) => b.byteLength / 2 / RATE;

describe("env parsers", () => {
	test("LH_STT_PIECE_S: min-max, sane or nothing", () => {
		assert.deepEqual(parsePieceSeconds("3-8"), { minS: 3, maxS: 8 });
		assert.deepEqual(parsePieceSeconds(" 2.5 - 12 "), { minS: 2.5, maxS: 12 });
		for (const bad of [undefined, "", "8", "8-3", "3-3", "0-5", "3-26", "a-b", "3,8"]) assert.equal(parsePieceSeconds(bad), null, String(bad));
	});

	test("LH_WHISPER_MAX_S: 2-25 seconds or no cap", () => {
		assert.equal(parseMaxRequestSeconds("12"), 12);
		assert.equal(parseMaxRequestSeconds("2"), 2);
		for (const bad of [undefined, "", "1", "26", "x", "0"]) assert.equal(parseMaxRequestSeconds(bad), null, String(bad));
	});
});

describe("splitPcm", () => {
	test("audio that fits comes back as the same one chunk", () => {
		const a = pcm(10);
		const out = splitPcm(a, 12);
		assert.equal(out.length, 1);
		assert.equal(out[0], a);
	});

	test("every chunk is within the cap and together they are the original, in order", () => {
		const a = pcm(30);
		const out = splitPcm(a, 12);
		assert.ok(out.length >= 3);
		for (const c of out) assert.ok(seconds(c) <= 12 + 1e-9, `chunk of ${seconds(c)} s`);
		const joined = new Uint8Array(out.reduce((n, c) => n + c.byteLength, 0));
		let at = 0;
		for (const c of out) { joined.set(c, at); at += c.byteLength; }
		assert.deepEqual(joined, a);
	});

	test("a cut lands in the quiet gap near the end of a chunk, not in speech", () => {
		// a pause from 10.2 s to 10.6 s; the first chunk may be 12 s long
		const out = splitPcm(pcm(20, [[10.2, 10.6]]), 12);
		const first = seconds(out[0]!);
		assert.ok(first >= 10.2 && first <= 10.8, `first chunk ends at ${first} s`);
	});

	test("an odd byte offset (a view into a bigger buffer) still works", () => {
		const a = pcm(15);
		const shifted = new Uint8Array(a.byteLength + 1);
		shifted.set(a, 1);
		const view = shifted.subarray(1);
		assert.equal(view.byteOffset % 2, 1);
		const out = splitPcm(view, 12);
		assert.equal(out.length, 2);
		assert.equal(out.reduce((n, c) => n + c.byteLength, 0), a.byteLength);
	});
});

describe("the segmenter with limits from the server", () => {
	const FRAME = 1600;
	const loud = () => Int16Array.from({ length: FRAME }, (_, i) => (i % 2 ? 9000 : -9000));
	const quiet = () => Int16Array.from({ length: FRAME }, () => 5);
	const run = (seg: ReturnType<typeof createSegmenter>, secs: number, make: () => Int16Array): number[] => {
		const out: number[] = [];
		for (let i = 0; i < Math.round((secs * RATE) / FRAME); i++) {
			const p = seg.push(make());
			if (p) out.push(p.byteLength / 2 / RATE);
		}
		return out;
	};

	test("short limits cut after 3 s at a pause and never pass 8 s", () => {
		const seg = createSegmenter(RATE, () => ({ minS: 3, maxS: 8 }));
		assert.deepEqual(run(seg, 3.2, loud), []);
		const cut = run(seg, 1, quiet);
		assert.equal(cut.length, 1);
		assert.ok(cut[0]! >= 3 && cut[0]! < 5, `cut at ${cut[0]} s`);
		const capped = run(createSegmenter(RATE, () => ({ minS: 3, maxS: 8 })), 20, loud);
		assert.ok(capped.length >= 2 && capped.every((s) => s <= 8 + 0.2), `pieces ${capped.join(", ")}`);
	});

	test("limits that arrive after recording started apply from the next frame", () => {
		let limits = { minS: 8, maxS: 25 };
		const seg = createSegmenter(RATE, () => limits);
		assert.deepEqual(run(seg, 2, loud), []);
		limits = { minS: 3, maxS: 8 }; // the prepare answer lands
		const out = run(seg, 12, loud);
		assert.ok(out.length >= 1 && out[0]! <= 8 + 0.2, `first piece ${out[0]} s`);
	});
});

describe("what the engine asks of the client", () => {
	test("custom limits only for whisper.cpp with LH_STT_PIECE_S set and sane", () => {
		const saved = { engine: process.env.LH_STT_ENGINE, pieces: process.env.LH_STT_PIECE_S };
		try {
			delete process.env.LH_STT_ENGINE;
			process.env.LH_STT_PIECE_S = "3-8";
			assert.equal(sttPieceLimits(), null, "the transformers.js engine keeps the desktop defaults");
			process.env.LH_STT_ENGINE = "whispercpp";
			assert.deepEqual(sttPieceLimits(), { minS: 3, maxS: 8 });
			process.env.LH_STT_PIECE_S = "nonsense";
			assert.equal(sttPieceLimits(), null);
			delete process.env.LH_STT_PIECE_S;
			assert.equal(sttPieceLimits(), null);
		} finally {
			for (const [k, v] of [["LH_STT_ENGINE", saved.engine], ["LH_STT_PIECE_S", saved.pieces]] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});
});
