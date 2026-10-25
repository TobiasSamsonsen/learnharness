/**
 * The speech worker's PCM decoding (fork addition, 2026-10-25) — its own
 * module so tests import it without loading transformers.js (the worker
 * itself, src/server/stt/worker.mjs, is forked, never imported).
 */

/** Int16 LE bytes → Float32 samples + the clip's peak level. The IPC
 *  deserializer hands the clip over as a VIEW into its message buffer, at
 *  whatever offset the message's other fields left — an odd offset makes
 *  `new Int16Array` throw ("start offset of Int16Array should be a
 *  multiple of 2"), so an unaligned view is copied to a fresh buffer. */
export function toFloat(pcm) {
	const bytes = pcm.byteOffset % 2 === 0 ? pcm : pcm.slice();
	const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
	const out = new Float32Array(samples.length);
	let peak = 0;
	for (let i = 0; i < samples.length; i++) {
		const v = samples[i] / 32768;
		out[i] = v;
		const a = v < 0 ? -v : v;
		if (a > peak) peak = a;
	}
	return { audio: out, peak };
}
