/**
 * The local speech-to-text worker (fork addition, 2026-10-24).
 *
 * A child process (src/server/stt-local.ts forks it with the server's own
 * binary) that runs Whisper through transformers.js + onnxruntime-node.
 * Kept OUT of the server process on purpose:
 *   - transformers.js imports sharp (libvips) at load. The app's rule is
 *     one native image lib per process, app code carrying none
 *     (headless.ts) — and in here sharp is stubbed out entirely by the
 *     resolve hook below (audio never touches images).
 *   - inference is seconds of CPU per clip; the server's event loop stays
 *     free, and the parent can kill this process when idle to hand the
 *     model's memory (~1 GB) back.
 *
 * Protocol (IPC, advanced serialization):
 *   parent → { id, op: "prepare", repo }
 *            { id, op: "transcribe", repo, whisper, pcm: Uint8Array (Int16 LE, 16 kHz mono) }
 *   worker → { op: "progress", repo, progress: 0..1 }   (downloads)
 *            { op: "loaded", repo }                     (model warm)
 *            { id, ok: true, text? } | { id, ok: false, error }
 */
import { register } from "node:module";

// sharp → a stub that throws if anything ever asks it for an image:
// transformers.js only needs the import to be truthy at load.
const SHARP_STUB = 'export default function sharp() { throw new Error("no image support in the speech worker"); }';
register(
	"data:text/javascript," +
		encodeURIComponent(
			"export async function resolve(specifier, context, next) {" +
				` if (specifier === "sharp") return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(SHARP_STUB))}, shortCircuit: true };` +
				" return next(specifier, context); }",
		),
);

const { pipeline, env } = await import("@huggingface/transformers");

env.cacheDir = process.env.LH_STT_CACHE_DIR;
env.allowLocalModels = false; // repo ids always mean the Hub (cached after the first download)

/** repo → Promise<pipeline>: each model loads once per worker lifetime. */
const pipelines = new Map();

function load(repo) {
	let p = pipelines.get(repo);
	if (!p) {
		const files = new Map(); // file → { loaded, total }
		let last = -1;
		p = pipeline("automatic-speech-recognition", repo, {
			dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
			device: "cpu",
			progress_callback: (info) => {
				if (info.status !== "progress" || !info.total) return;
				files.set(info.file, { loaded: info.loaded, total: info.total });
				let loaded = 0;
				let total = 0;
				for (const f of files.values()) {
					loaded += f.loaded;
					total += f.total;
				}
				const progress = total > 0 ? loaded / total : 0;
				// whole percents only: the IPC channel is not a firehose
				if (Math.floor(progress * 100) !== last) {
					last = Math.floor(progress * 100);
					process.send?.({ op: "progress", repo, progress });
				}
			},
		}).then(
			(asr) => {
				process.send?.({ op: "loaded", repo });
				return asr;
			},
			(err) => {
				pipelines.delete(repo); // a failed load (offline, disk) retries next time
				throw err;
			},
		);
		pipelines.set(repo, p);
	}
	return p;
}

/** Below this peak level the clip is silence: Whisper hallucinates on
 *  silence ("Takk for at du så på!"), so silence transcribes to nothing. */
const SILENCE_PEAK = 0.01;

function toFloat(pcm) {
	const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
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

process.on("message", async (msg) => {
	const reply = (body) => process.send?.({ id: msg.id, ...body });
	try {
		if (msg.op === "prepare") {
			await load(msg.repo);
			reply({ ok: true });
		} else if (msg.op === "transcribe") {
			const asr = await load(msg.repo);
			const { audio, peak } = toFloat(msg.pcm);
			if (audio.length < 1600 || peak < SILENCE_PEAK) {
				reply({ ok: true, text: "" }); // < 0.1 s, or silence
				return;
			}
			const out = await asr(audio, {
				language: msg.whisper,
				task: "transcribe",
				chunk_length_s: 30,
				stride_length_s: 5,
			});
			const text = (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
			reply({ ok: true, text });
		} else {
			reply({ ok: false, error: `unknown op ${msg.op}` });
		}
	} catch (err) {
		reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
	}
});

// The parent's death closes the channel: never outlive it.
process.on("disconnect", () => process.exit(0));
