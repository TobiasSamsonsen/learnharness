/**
 * Live dictation's segmenter (owner, 2026-10-25): the local engine no
 * longer waits for the whole recording — it cuts the audio at natural
 * pauses and transcribes each piece while the learner keeps talking, so
 * at stop only the last piece is left. Pure (no audio APIs), so the cut
 * rule is pinned in tests.
 *
 * The cut rule:
 *   - a piece is at least MIN_PIECE_S long, then ends at the first pause
 *     of PAUSE_S (quiet frames in a row);
 *   - a piece never passes MAX_PIECE_S (Whisper reads 30 s at a time):
 *     then it is cut at the quietest frame of the last LOOKBACK_S, so no
 *     word is split.
 * Quiet is judged against the mic's own background: a frame is quiet when
 * its level is below a multiple of the run's noise floor (the quietest
 * recent level), within absolute bounds — mics differ.
 */

import type { PieceLimits } from "@/src/core";

export const MIN_PIECE_S = 8;
export const PAUSE_S = 0.6;
export const MAX_PIECE_S = 25;
export const LOOKBACK_S = 4;
/** Quiet = below floor × FLOOR_FACTOR, kept within [MIN_QUIET_RMS,
 *  MAX_QUIET_RMS]: the ceiling stops a run that starts mid-speech (its
 *  floor then sits at speech level) from reading speech as a pause. */
const FLOOR_FACTOR = 2.5;
const MIN_QUIET_RMS = 0.006;
const MAX_QUIET_RMS = 0.03;
/** The floor creeps up slowly, so a noisy start does not pin it low forever. */
const FLOOR_RISE = 1.002;

/** RMS of an Int16 frame, 0..1. Pure. */
export function frameRms(frame: Int16Array): number {
	if (frame.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < frame.length; i++) {
		const v = frame[i]! / 32768;
		sum += v * v;
	}
	return Math.sqrt(sum / frame.length);
}

/** Concatenate Int16 frames into one clip's bytes (Int16 LE). Pure. */
export function joinPiece(frames: readonly Int16Array[]): Uint8Array<ArrayBuffer> {
	const total = frames.reduce((n, f) => n + f.length, 0);
	const out = new Int16Array(total);
	let at = 0;
	for (const f of frames) {
		out.set(f, at);
		at += f.length;
	}
	return new Uint8Array(out.buffer);
}

export interface Segmenter {
	/** One captured frame; returns a finished piece's bytes when this frame ends one. */
	push(frame: Int16Array): Uint8Array<ArrayBuffer> | null;
	/** The rest (at stop); null when nothing is left. */
	flush(): Uint8Array<ArrayBuffer> | null;
}

/** The desktop limits; a server can ask for others (`LH_STT_PIECE_S`, Android plan M7b). */
export const DEFAULT_PIECE_LIMITS: PieceLimits = { minS: MIN_PIECE_S, maxS: MAX_PIECE_S };

/** `limits` is read on every frame, so limits that arrive from the server a moment after recording starts still apply. */
export function createSegmenter(sampleRate = 16000, limits: () => PieceLimits = () => DEFAULT_PIECE_LIMITS): Segmenter {
	let frames: Int16Array[] = [];
	let levels: number[] = [];
	let samples = 0;
	let quietSamples = 0;
	let floor = Infinity;

	const take = (count: number): Uint8Array<ArrayBuffer> => {
		const piece = joinPiece(frames.slice(0, count));
		frames = frames.slice(count);
		levels = levels.slice(count);
		samples = frames.reduce((n, f) => n + f.length, 0);
		quietSamples = 0;
		return piece;
	};

	return {
		push(frame) {
			const { minS, maxS } = limits();
			const rms = frameRms(frame);
			floor = Math.min(rms, floor === Infinity ? rms : floor * FLOOR_RISE);
			const quiet = rms < Math.min(MAX_QUIET_RMS, Math.max(floor * FLOOR_FACTOR, MIN_QUIET_RMS));
			frames.push(frame);
			levels.push(rms);
			samples += frame.length;
			quietSamples = quiet ? quietSamples + frame.length : 0;
			if (samples >= minS * sampleRate && quietSamples >= PAUSE_S * sampleRate) return take(frames.length);
			if (samples >= maxS * sampleRate) {
				// cut after the quietest frame of the last few seconds
				let lookback = 0;
				let start = frames.length;
				while (start > 1 && lookback < LOOKBACK_S * sampleRate) lookback += frames[--start]!.length;
				let best = start;
				for (let i = start; i < frames.length; i++) if (levels[i]! < levels[best]!) best = i;
				return take(best + 1);
			}
			return null;
		},
		flush() {
			return frames.length > 0 ? take(frames.length) : null;
		},
	};
}

/** A piece's transcription, as the local route answers it. */
export type PieceResult = { ok: true; text: string } | { ok: false; error: string };

export interface PieceQueue {
	/** A finished piece: transcribed after every piece before it. */
	add(piece: Uint8Array<ArrayBuffer>): void;
	/** Resolves once every added piece is delivered (or held back by a failure). */
	drain(): Promise<void>;
	/** After a failure: its error and the audio NOT transcribed — the failed
	 *  piece and every piece after it, joined in order (Retry sends it). */
	failed(): { error: string; clip: Uint8Array<ArrayBuffer> } | null;
	/** Esc / teardown: nothing more is delivered. */
	cancel(): void;
}

/** Transcribes pieces one at a time, in order, delivering each text as it
 *  lands. The first failure pauses it: later pieces are kept, not sent, so
 *  the text never arrives out of order. */
export function createPieceQueue(deps: { transcribe: (piece: Uint8Array<ArrayBuffer>) => Promise<PieceResult>; deliver: (text: string) => void }): PieceQueue {
	let tail: Promise<void> = Promise.resolve();
	let cancelled = false;
	let failure: { error: string; parts: Uint8Array<ArrayBuffer>[] } | null = null;
	return {
		add(piece) {
			tail = tail.then(async () => {
				if (cancelled) return;
				if (failure) {
					failure.parts.push(piece);
					return;
				}
				const result = await deps.transcribe(piece).catch((e: unknown): PieceResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
				if (cancelled) return;
				if (!result.ok) failure = { error: result.error, parts: [piece] };
				else if (result.text) deps.deliver(result.text);
			});
		},
		drain() {
			return tail;
		},
		failed() {
			if (!failure) return null;
			const total = failure.parts.reduce((n, p) => n + p.byteLength, 0);
			const clip = new Uint8Array(total);
			let at = 0;
			for (const p of failure.parts) {
				clip.set(p, at);
				at += p.byteLength;
			}
			return { error: failure.error, clip };
		},
		cancel() {
			cancelled = true;
		},
	};
}

/** Take a dictated piece back out of a field's text (Esc): the LAST
 *  occurrence, with the space joinDictation put before it. A field edited
 *  so the piece is no longer there keeps its text. Pure. */
export function withdrawDictation(current: string, piece: string): string {
	const at = current.lastIndexOf(piece);
	if (at < 0) return current;
	const before = current.slice(0, at);
	const after = current.slice(at + piece.length);
	return (after ? before : before.replace(/ $/, "")) + after;
}
