/**
 * Lesson languages (fork addition, 2026-10-24): the pure core, the
 * request parsers and sanitizer, the agent prompt seam, and the dictation
 * helpers. The local speech worker itself needs downloaded models and is
 * exercised live, not here (no network in this suite).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createFauxCore } from "@earendil-works/pi-ai";
import {
	LESSON_LANGUAGES,
	LOCAL_STT_MODELS,
	languageDirective,
	sttModelFiles,
	resolveLessonLanguage,
	withLanguageDirective,
} from "../src/core/language.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseGeneralSettingsBody, parseSettingsBody } from "../src/server/settings-body.ts";
import { createTeacherAgent, createProberAgent } from "../src/agent/teacher-agent.ts";
import { joinFrames, localStopLabel } from "../components/dictation.tsx";
import { localModelLine } from "../components/settings/language-section.tsx";

describe("the language core", () => {
	test("English gets a directive too — a lesson switched back from Norwegian must switch (live regression)", () => {
		for (const role of ["conversation", "extraction", "artifact"] as const) {
			assert.match(withLanguageDirective("BASE", "en", role), /^BASE\n\n<lesson_language>[\s\S]*English/);
		}
		assert.match(languageDirective("en", "conversation"), /if earlier messages are in another language, continue in English/);
	});

	test("Norwegian directives name Bokmål and append after the prompt", () => {
		const conversation = withLanguageDirective("BASE", "nb", "conversation");
		assert.match(conversation, /^BASE\n\n<lesson_language>\n/);
		assert.match(conversation, /Conduct this entire lesson in Norwegian Bokmål/);
		assert.match(languageDirective("nb", "extraction"), /proposition's name, statement and aliases in Norwegian Bokmål/);
		assert.match(languageDirective("nb", "artifact"), /learner-visible text .* in Norwegian Bokmål/);
	});

	test("a lesson without a stamp is English, never the current default", () => {
		assert.equal(resolveLessonLanguage(undefined), "en");
		assert.equal(resolveLessonLanguage({}), "en");
		assert.equal(resolveLessonLanguage({ language: "nb" }), "nb");
	});

	test("every language has a local speech model and engine codes", () => {
		for (const l of LESSON_LANGUAGES) {
			assert.ok(LOCAL_STT_MODELS[l.id].repo);
			assert.ok(l.whisper && l.deepgram && l.short);
		}
		// owner, 2026-10-25: the large models on the GPU, the small q8 ones as the CPU fallback
		assert.deepEqual(
			[LOCAL_STT_MODELS.nb.repo, LOCAL_STT_MODELS.nb.dtype, LOCAL_STT_MODELS.nb.device],
			["Hjertelig/nb-whisper-large-ONNX", "q4", "webgpu"],
		);
		assert.deepEqual(
			[LOCAL_STT_MODELS.en.repo, LOCAL_STT_MODELS.en.dtype, LOCAL_STT_MODELS.en.device],
			["onnx-community/whisper-large-v3-turbo", "fp16", "webgpu"],
		);
		for (const l of LESSON_LANGUAGES) {
			assert.equal(LOCAL_STT_MODELS[l.id].fallback.device, "cpu");
			assert.equal(LOCAL_STT_MODELS[l.id].fallback.dtype, "q8");
		}
		assert.equal(LOCAL_STT_MODELS.nb.fallback.repo, "onnx-community/nb-whisper-small-ONNX");
	});

	test("a model's files on disk follow transformers.js's naming by dtype", () => {
		assert.deepEqual(sttModelFiles("q8"), ["onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx", "tokenizer.json"]);
		assert.deepEqual(sttModelFiles("q4").slice(0, 2), ["onnx/encoder_model_q4.onnx", "onnx/decoder_model_merged_q4.onnx"]);
		assert.deepEqual(sttModelFiles("fp16").slice(0, 2), ["onnx/encoder_model_fp16.onnx", "onnx/decoder_model_merged_fp16.onnx"]);
	});
});

describe("settings: parse strictly, sanitize leniently", () => {
	test("general accepts a language and an engine, rejects unknown values", () => {
		const ok = parseGeneralSettingsBody({ autoUpdate: true, language: "nb", dictationEngine: "deepgram" });
		assert.deepEqual(ok, { ok: true, settings: { autoUpdate: true, language: "nb", dictationEngine: "deepgram" } });
		assert.equal(parseGeneralSettingsBody({ language: "sv" }).ok, false);
		assert.equal(parseGeneralSettingsBody({ dictationEngine: "whisper" }).ok, false);
	});

	test("a lesson's settings carry its language; bad languages 400", () => {
		assert.deepEqual(parseSettingsBody({ language: "nb" }), { ok: true, settings: { language: "nb" } });
		const bad = parseSettingsBody({ language: "de" });
		assert.equal(bad.ok, false);
		assert.match(bad.ok ? "" : bad.error, /language must be one of: en, nb/);
	});

	test("the record sanitizer keeps valid values and drops invalid ones", () => {
		assert.deepEqual(sanitizeUserSettings({ general: { language: "nb", dictationEngine: "local" } })?.general, {
			language: "nb",
			dictationEngine: "local",
		});
		assert.deepEqual(sanitizeUserSettings({ general: { language: "xx", dictationEngine: 3 } })?.general, {});
	});
});

describe("the agent prompt seam", () => {
	const engine = () => {
		const faux = createFauxCore({});
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	};

	test("a Norwegian lesson's teacher and prober carry the conversation directive", () => {
		const teacher = createTeacherAgent(undefined, { engine: engine(), language: "nb" });
		assert.match(teacher.state.systemPrompt, /<lesson_language>[\s\S]*Norwegian Bokmål/);
		const prober = createProberAgent(
			{ chatId: "chat_x", chatStore: undefined as never, deliver: () => {} } as never,
			{ engine: engine(), language: "nb" },
		);
		assert.match(prober.state.systemPrompt, /Conduct this entire lesson in Norwegian Bokmål/);
	});

	test("an unstamped lesson is taught in English, the same prompt as an explicit English stamp", () => {
		const absent = createTeacherAgent(undefined, { engine: engine() }).state.systemPrompt;
		assert.equal(createTeacherAgent(undefined, { engine: engine(), language: "en" }).state.systemPrompt, absent);
		assert.match(absent, /Conduct this entire lesson in English/);
		assert.doesNotMatch(absent, /Norwegian/);
	});
});

describe("dictation helpers", () => {
	test("the local stop line reports a first download's progress, else transcribing", () => {
		const base = { language: "nb" as const, repo: "r", sizeMb: 410 };
		assert.equal(localStopLabel({ ...base, state: "downloading", progress: 0.374 }), "Downloading speech model 37%");
		assert.equal(localStopLabel({ ...base, state: "loading" }), "Loading speech model");
		assert.equal(localStopLabel({ ...base, state: "ready" }), "Transcribing");
		assert.equal(localStopLabel(undefined), "Transcribing");
	});

	test("the worklet's Int16Array frames join as their raw bytes (live regression: 'you')", () => {
		// the real shape: the worklet posts Int16Array frames, not ArrayBuffers
		const frames = [new Int16Array([1000, -1000, 32767]), new Int16Array([-32768, 7])];
		const clip = joinFrames(frames);
		assert.equal(clip.byteLength, 10, "2 bytes per sample, no zero-padded tail");
		assert.deepEqual([...new Int16Array(clip.buffer)], [1000, -1000, 32767, -32768, 7], "samples survive exactly");
		// a view into a larger buffer contributes only its own bytes
		const big = new Int16Array([9, 9, 42, 43, 9]);
		assert.deepEqual([...new Int16Array(joinFrames([big.subarray(2, 4)]).buffer)], [42, 43]);
	});

	test("a run's frames join in order into one clip", () => {
		const a = new Int16Array([1, 2]).buffer;
		const b = new Int16Array([3]).buffer;
		assert.deepEqual([...new Int16Array(joinFrames([a, b]).buffer)], [1, 2, 3]);
		assert.equal(joinFrames([]).byteLength, 0);
	});

	test("the worker decodes a clip at an ODD byte offset (live regression: 'start offset of Int16Array')", async () => {
		const { toFloat } = (await import("../src/server/stt/pcm.mjs")) as { toFloat: (pcm: Uint8Array) => { audio: Float32Array; peak: number } };
		// IPC hands the clip over as a view into its message buffer — here at offset 3
		const samples = new Int16Array([16384, -32768, 0]);
		const message = new Uint8Array(3 + samples.byteLength);
		message.set(new Uint8Array(samples.buffer), 3);
		const view = message.subarray(3);
		assert.equal(view.byteOffset % 2, 1, "the fixture really is unaligned");
		const { audio, peak } = toFloat(view);
		assert.deepEqual([...audio], [0.5, -1, 0]);
		assert.equal(peak, 1);
		// an aligned view decodes the same, without a copy
		assert.deepEqual([...toFloat(new Uint8Array(samples.buffer)).audio], [0.5, -1, 0]);
	});

	test("the speech engine: the GPU model unless it failed; then the CPU fallback, for the clip and until restart", async () => {
		const { createEngine } = (await import("../src/server/stt/engine.mjs")) as {
			createEngine: (deps: { load: (spec: { repo: string }) => Promise<unknown>; onGpuFailed?: (m: string) => void }) => {
				prepare: (m: object, f: object) => Promise<string>;
				transcribe: (m: object, f: object, run: (asr: unknown) => Promise<string>) => Promise<{ text: string; ranOn: string }>;
				gpuBroken: string | null;
			};
		};
		const gpu = { repo: "big" }, cpu = { repo: "small" };
		const loads: string[] = [];
		const ok = createEngine({ load: async (s) => (loads.push(s.repo), s.repo) });
		assert.equal(await ok.prepare(gpu, cpu), "gpu");
		assert.deepEqual(await ok.transcribe(gpu, cpu, async (asr) => `by ${asr}`), { text: "by big", ranOn: "gpu" });
		assert.deepEqual(loads, ["big", "big"], "the fallback is never loaded while the GPU works");

		// no adapter: the load fails → the fallback, and it stays there
		const failures: string[] = [];
		const noGpu = createEngine({
			load: async (s) => {
				if (s.repo === "big") throw new Error("no WebGPU adapter");
				return s.repo;
			},
			onGpuFailed: (m) => failures.push(m),
		});
		assert.deepEqual(await noGpu.transcribe(gpu, cpu, async (asr) => `by ${asr}`), { text: "by small", ranOn: "cpu-fallback" });
		assert.equal(await noGpu.prepare(gpu, cpu), "cpu-fallback");
		assert.deepEqual(failures, ["no WebGPU adapter"], "reported once; not retried until restart");

		// the GPU fails mid-clip: the SAME clip is retried on the fallback
		let calls = 0;
		const midClip = createEngine({ load: async (s) => s.repo });
		const out = await midClip.transcribe(gpu, cpu, async (asr) => {
			calls++;
			if (asr === "big") throw new Error("device lost");
			return "recovered";
		});
		assert.deepEqual(out, { text: "recovered", ranOn: "cpu-fallback" });
		assert.equal(calls, 2);
		assert.equal(midClip.gpuBroken, "device lost");
		// a CPU failure is a real failure — no loop
		await assert.rejects(noGpu.transcribe(gpu, cpu, async () => { throw new Error("bad audio"); }), /bad audio/);
	});

	test("the settings row describes each model state", () => {
		const base = { language: "en" as const, repo: "r", sizeMb: 250 };
		assert.equal(localModelLine({ ...base, state: "absent" }), "not downloaded · 250 MB");
		assert.equal(localModelLine({ ...base, state: "downloading", progress: 0.5 }), "downloading 50%");
		assert.equal(localModelLine({ ...base, state: "cached" }), "downloaded");
		assert.equal(localModelLine({ ...base, state: "error", error: "offline" }), "failed — offline");
		assert.equal(localModelLine({ ...base, state: "ready", ranOn: "gpu" }), "ready · GPU");
		assert.equal(localModelLine({ ...base, state: "cached", ranOn: "cpu-fallback" }), "downloaded · GPU unavailable, using the small CPU model");
	});
});
