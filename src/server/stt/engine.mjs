/**
 * The speech worker's model choice (owner, 2026-10-25) — its own module so
 * tests drive it with fake loaders (the worker itself is forked, never
 * imported).
 *
 * The GPU model runs unless it has failed in this worker: a failed load
 * (no WebGPU adapter, a driver error) or a failed transcription switches
 * to the CPU fallback — for the clip at hand, and until the worker
 * restarts (the parent stops an idle worker after 10 minutes).
 */

/** @param {{ load: (spec: object) => Promise<Function>, onGpuFailed?: (message: string) => void }} deps */
export function createEngine({ load, onGpuFailed = () => {} }) {
	/** Why the GPU model is unusable in this worker; null while it is fine. */
	let gpuBroken = null;
	const failed = (err) => {
		gpuBroken = err instanceof Error ? err.message : String(err);
		onGpuFailed(gpuBroken);
	};

	/** The model to use now. */
	async function pick(model, fallback) {
		if (!gpuBroken) {
			try {
				return { asr: await load(model), ranOn: "gpu" };
			} catch (err) {
				failed(err);
			}
		}
		return { asr: await load(fallback), ranOn: "cpu-fallback" };
	}

	return {
		/** Warm the model a transcription would use. */
		async prepare(model, fallback) {
			return (await pick(model, fallback)).ranOn;
		},
		/** Transcribe with `run(asr)`; a GPU failure mid-clip retries the clip on the fallback. */
		async transcribe(model, fallback, run) {
			const { asr, ranOn } = await pick(model, fallback);
			try {
				return { text: await run(asr), ranOn };
			} catch (err) {
				if (ranOn !== "gpu") throw err;
				failed(err);
				return { text: await run(await load(fallback)), ranOn: "cpu-fallback" };
			}
		},
		get gpuBroken() {
			return gpuBroken;
		},
	};
}
