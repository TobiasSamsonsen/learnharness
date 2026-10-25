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
 * Protocol (IPC, advanced serialization) — a model spec is
 * { repo, dtype: "q8"|"q4"|"fp16", device: "webgpu"|"cpu" } (core/language.ts):
 *   parent → { id, op: "prepare", model, fallback }
 *            { id, op: "transcribe", model, fallback, whisper, pcm: Uint8Array (Int16 LE, 16 kHz mono) }
 *   worker → { op: "progress", repo, progress: 0..1 }   (downloads)
 *            { op: "loaded", repo }                     (model warm)
 *            { id, ok: true, text?, ranOn: "gpu"|"cpu-fallback" } | { id, ok: false, error }
 *
 * THE GPU PATH (owner, 2026-10-25): `model` runs on the GPU, `fallback`
 * (the small CPU model) when it cannot — engine.mjs owns that choice.
 */
import { register } from "node:module";
import { toFloat } from "./pcm.mjs";
import { createEngine } from "./engine.mjs";

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

/** repo|dtype|device → Promise<pipeline>: each model loads once per worker lifetime. */
const pipelines = new Map();

function load({ repo, dtype, device }) {
	const key = `${repo}|${dtype}|${device}`;
	let p = pipelines.get(key);
	if (!p) {
		const files = new Map(); // file → { loaded, total }
		let last = -1;
		p = pipeline("automatic-speech-recognition", repo, {
			dtype: { encoder_model: dtype, decoder_model_merged: dtype },
			device,
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
				pipelines.delete(key); // a failed load (offline, disk) retries next time
				throw err;
			},
		);
		pipelines.set(key, p);
	}
	return p;
}

/** Below this peak level the clip is silence: Whisper hallucinates on
 *  silence ("Takk for at du så på!"), so silence transcribes to nothing. */
const SILENCE_PEAK = 0.01;

const engine = createEngine({
	load,
	onGpuFailed: (why) => console.error(`[stt] GPU model unusable — using the CPU fallback until restart: ${why}`),
});

async function run(asr, audio, whisper) {
	const out = await asr(audio, { language: whisper, task: "transcribe", chunk_length_s: 30, stride_length_s: 5 });
	return (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
}

process.on("message", async (msg) => {
	const reply = (body) => process.send?.({ id: msg.id, ...body });
	try {
		if (msg.op === "prepare") {
			reply({ ok: true, ranOn: await engine.prepare(msg.model, msg.fallback) });
		} else if (msg.op === "transcribe") {
			const { audio, peak } = toFloat(msg.pcm);
			if (audio.length < 1600 || peak < SILENCE_PEAK) {
				reply({ ok: true, text: "" }); // < 0.1 s, or silence
				return;
			}
			const { text, ranOn } = await engine.transcribe(msg.model, msg.fallback, (asr) => run(asr, audio, msg.whisper));
			reply({ ok: true, text, ranOn });
		} else {
			reply({ ok: false, error: `unknown op ${msg.op}` });
		}
	} catch (err) {
		reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
	}
});

// The parent's death closes the channel: never outlive it.
process.on("disconnect", () => process.exit(0));
