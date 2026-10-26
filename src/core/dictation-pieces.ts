/**
 * Dictation piece sizing (Android plan M7b). PURE, browser-safe.
 *
 * Live dictation cuts the learner's speech into pieces and transcribes them
 * one after another. The desktop defaults (8-25 s) suit a fast engine; a
 * phone running whisper.cpp with a short audio context needs short pieces,
 * and a hard cap so a longer clip is never truncated by the server.
 */

/** How long a live piece may be: it ends at a pause after `minS`, never passes `maxS`. */
export interface PieceLimits {
	minS: number;
	maxS: number;
}

/** The longest piece the live segmenter ever produces (Whisper reads 30 s at a time). */
export const MAX_PIECE_CEILING_S = 25;

const SAMPLE_RATE = 16000;
const FRAME = SAMPLE_RATE / 10; // 0.1 s
const LOOKBACK_S = 4;

/** `LH_STT_PIECE_S`: "3-8" → {minS: 3, maxS: 8}; anything unusable → null (defaults stand). */
export function parsePieceSeconds(raw: string | undefined): PieceLimits | null {
	const m = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(raw ?? "");
	if (!m) return null;
	const minS = Number(m[1]);
	const maxS = Number(m[2]);
	if (!(minS >= 1) || !(maxS > minS) || maxS > MAX_PIECE_CEILING_S) return null;
	return { minS, maxS };
}

/** `LH_WHISPER_MAX_S`: the hard cap on one whisper request, in seconds (2-25); unusable → null (no cap). */
export function parseMaxRequestSeconds(raw: string | undefined): number | null {
	const n = Number((raw ?? "").trim());
	if (!(n >= 2) || n > MAX_PIECE_CEILING_S) return null;
	return n;
}

function frameRms(pcm: Int16Array, from: number, to: number): number {
	let sum = 0;
	for (let i = from; i < to; i++) {
		const v = pcm[i]! / 32768;
		sum += v * v;
	}
	return Math.sqrt(sum / Math.max(1, to - from));
}

/**
 * Split 16 kHz mono Int16 LE PCM into chunks of at most `maxSeconds`. A cut
 * lands after the quietest 0.1 s frame of the chunk's last few seconds (the
 * live segmenter's own rule), so no word is split where a gap exists. Audio
 * that already fits comes back as the one chunk, untouched.
 */
export function splitPcm(input: Uint8Array, maxSeconds: number): Uint8Array[] {
	const bytes = input.byteOffset % 2 === 0 ? input : input.slice(); // Int16Array needs an even offset
	const maxSamples = Math.floor(maxSeconds * SAMPLE_RATE);
	const total = Math.floor(bytes.byteLength / 2);
	if (total <= maxSamples) return [input];
	const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, total);
	const out: Uint8Array[] = [];
	let start = 0;
	while (total - start > maxSamples) {
		const end = start + maxSamples;
		const lookStart = Math.max(start + FRAME, end - Math.min(LOOKBACK_S * SAMPLE_RATE, Math.floor(maxSamples / 2)));
		let cut = end;
		let best = Infinity;
		for (let f = Math.floor(lookStart / FRAME) * FRAME; f + FRAME <= end; f += FRAME) {
			const level = frameRms(pcm, f, f + FRAME);
			if (level <= best) {
				best = level;
				cut = f + FRAME;
			}
		}
		out.push(new Uint8Array(bytes.buffer, bytes.byteOffset + start * 2, (cut - start) * 2));
		start = cut;
	}
	out.push(new Uint8Array(bytes.buffer, bytes.byteOffset + start * 2, (total - start) * 2));
	return out;
}
