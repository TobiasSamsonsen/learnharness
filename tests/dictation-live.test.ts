/**
 * Live local dictation (owner, 2026-10-25 — components/dictation-live.ts):
 * the cut rule (pieces end at a pause after enough speech, never pass the
 * cap, never split at a loud frame), the in-order queue that pauses at the
 * first failure, and Esc's take-back.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PIECE_S, MIN_PIECE_S, createPieceQueue, createSegmenter, frameRms, joinPiece, withdrawDictation, type PieceResult } from "../components/dictation-live.ts";
import { joinDictation } from "../components/dictation.tsx";

const RATE = 16000;
const FRAME = 2048; // the worklet's frame: 128 ms
/** A frame at a given loudness (a square wave of that amplitude). */
const frame = (amp: number, tag = 0) => Int16Array.from({ length: FRAME }, (_, i) => (i === 0 ? tag : i % 2 ? amp : -amp) * 1);
const loud = (tag = 0) => frame(9000, tag);
const quiet = () => frame(20);
/** Feed n seconds of frames; returns every piece emitted (as sample counts). */
function feed(seg: ReturnType<typeof createSegmenter>, seconds: number, make: () => Int16Array): number[] {
	const out: number[] = [];
	for (let i = 0; i < Math.round((seconds * RATE) / FRAME); i++) {
		const piece = seg.push(make());
		if (piece) out.push(piece.byteLength / 2);
	}
	return out;
}

describe("the segmenter", () => {
	test("frame level and piece joining", () => {
		assert.ok(frameRms(loud()) > 0.2);
		assert.ok(frameRms(quiet()) < 0.002);
		assert.deepEqual([...new Int16Array(joinPiece([Int16Array.from([1, 2]), Int16Array.from([3])]).buffer)], [1, 2, 3]);
	});

	test("a pause BEFORE the minimum length never cuts; the first pause after it does", () => {
		const seg = createSegmenter();
		assert.deepEqual(feed(seg, 3, loud), []);
		assert.deepEqual(feed(seg, 1, quiet), [], "too short to end a piece");
		assert.deepEqual(feed(seg, MIN_PIECE_S, loud), []);
		const pieces = feed(seg, 1, quiet);
		assert.equal(pieces.length, 1, "the pause after enough speech ends the piece");
		assert.ok(pieces[0]! >= MIN_PIECE_S * RATE && pieces[0]! < (MIN_PIECE_S + 6) * RATE);
		assert.ok(seg.flush()!.byteLength > 0, "the pause's tail stays for the next piece");
		assert.equal(seg.flush(), null);
	});

	test("continuous speech is cut at the cap, at the quietest frame of the last seconds", () => {
		const seg = createSegmenter();
		let n = 0;
		// loud throughout, except one slightly quieter frame ~2 s before the cap
		const dipAt = Math.round(((MAX_PIECE_S - 2) * RATE) / FRAME);
		const pieces = feed(seg, MAX_PIECE_S + 1, () => (++n === dipAt ? frame(4000) : loud()));
		assert.equal(pieces.length, 1);
		assert.equal(pieces[0], dipAt * FRAME, "cut right after the quietest frame — never mid-word at the cap");
		// a run that starts mid-speech: speech is never mistaken for a pause
		const midSpeech = createSegmenter();
		assert.deepEqual(feed(midSpeech, MIN_PIECE_S + 2, loud), [], "no cut without a real pause");
		const rest = seg.flush()!;
		assert.ok(rest.byteLength > 0, "the remainder starts the next piece");
		assert.equal(seg.flush(), null, "nothing left after a flush");
	});

	test("a noisy room still finds its pauses (quiet is relative to the mic's own floor)", () => {
		const seg = createSegmenter();
		const noisy = () => frame(400); // room noise far above the absolute minimum
		feed(seg, 1, noisy);
		assert.deepEqual(feed(seg, MIN_PIECE_S + 1, loud), []);
		assert.equal(feed(seg, 1, noisy).length, 1);
	});
});

describe("the piece queue", () => {
	const piece = (n: number) => new Uint8Array([n, n]);
	const later = <T>(v: T, ms: number) => new Promise<T>((r) => setTimeout(() => r(v), ms));

	test("pieces land in order even when a later one is faster", async () => {
		const got: string[] = [];
		const q = createPieceQueue({
			transcribe: (p) => later<PieceResult>({ ok: true, text: `t${p[0]}` }, p[0] === 1 ? 30 : 1),
			deliver: (t) => got.push(t),
		});
		q.add(piece(1));
		q.add(piece(2));
		await q.drain();
		assert.deepEqual(got, ["t1", "t2"]);
		assert.equal(q.failed(), null);
	});

	test("the first failure pauses the queue: later pieces are kept, joined, for Retry", async () => {
		const got: string[] = [];
		const sent: number[] = [];
		const q = createPieceQueue({
			transcribe: async (p) => (sent.push(p[0]!), p[0] === 2 ? { ok: false, error: "GPU lost" } : { ok: true, text: `t${p[0]}` }),
			deliver: (t) => got.push(t),
		});
		for (const n of [1, 2, 3, 4]) q.add(piece(n));
		await q.drain();
		assert.deepEqual(got, ["t1"]);
		assert.deepEqual(sent, [1, 2], "nothing after the failure is sent out of order");
		assert.deepEqual(q.failed(), { error: "GPU lost", clip: new Uint8Array([2, 2, 3, 3, 4, 4]) });
	});

	test("a thrown transcription counts as a failure; empty text delivers nothing; cancel stops delivery", async () => {
		const got: string[] = [];
		const q = createPieceQueue({ transcribe: async () => { throw new Error("offline"); }, deliver: (t) => got.push(t) });
		q.add(piece(1));
		await q.drain();
		assert.equal(q.failed()!.error, "offline");

		const quietQ = createPieceQueue({ transcribe: async () => ({ ok: true, text: "" }), deliver: (t) => got.push(t) });
		quietQ.add(piece(1));
		await quietQ.drain();
		assert.equal(got.length, 0, "a silent piece adds nothing");

		const c = createPieceQueue({ transcribe: (p) => later<PieceResult>({ ok: true, text: `t${p[0]}` }, 20), deliver: (t) => got.push(t) });
		c.add(piece(1));
		c.cancel();
		await c.drain();
		assert.deepEqual(got, [], "a cancelled run delivers nothing more");
	});
});

describe("Esc takes the run's pieces back", () => {
	test("withdraw removes the last occurrence with its joining space", () => {
		let field = joinDictation("My answer", "first piece");
		field = joinDictation(field, "second piece");
		assert.equal(field, "My answer first piece second piece");
		field = joinDictation(field, "second piece", true);
		field = joinDictation(field, "first piece", true);
		assert.equal(field, "My answer", "back to what the learner typed");
		assert.equal(withdrawDictation("", "x"), "");
	});

	test("a piece the learner edited away stays as the learner left it", () => {
		assert.equal(withdrawDictation("I rewrote it all", "first piece"), "I rewrote it all");
		assert.equal(withdrawDictation("a first piece then typing", "first piece"), "a  then typing");
	});
});
