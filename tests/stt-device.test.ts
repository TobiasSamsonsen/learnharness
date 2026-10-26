/**
 * LH_STT_DEVICE (Android plan M6): with `cpu` the transformers.js engine is
 * handed only the small CPU model, so a device never downloads the 1.3-1.6 GB
 * WebGPU weights. The worker cannot enforce it alone; the server picks the spec.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LOCAL_STT_MODELS, parseSttDevice, sttModelFor } from "../src/core/language.ts";
import { localModelLine } from "../components/settings/language-section.tsx";

// config.ts reads LH_DATA_DIR at module load
process.env.LH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-stt-device-"));
const { localSttStatuses, sttDevice } = await import("../src/server/stt-local.ts");

test("parseSttDevice: auto unless cpu", () => {
	assert.equal(parseSttDevice(undefined), "auto");
	assert.equal(parseSttDevice(""), "auto");
	assert.equal(parseSttDevice("gpu"), "auto");
	assert.equal(parseSttDevice("cpu"), "cpu");
	assert.equal(parseSttDevice(" CPU "), "cpu");
});

test("sttModelFor: the GPU model on auto, the CPU fallback on cpu", () => {
	for (const language of ["en", "nb"] as const) {
		const m = LOCAL_STT_MODELS[language];
		assert.deepEqual(sttModelFor(language, "auto"), { repo: m.repo, dtype: m.dtype, device: m.device, sizeMb: m.sizeMb });
		assert.deepEqual(sttModelFor(language, "cpu"), m.fallback);
		assert.equal(sttModelFor(language, "cpu").device, "cpu");
	}
});

test("statuses report the model the device will load", () => {
	const saved = process.env.LH_STT_DEVICE;
	try {
		delete process.env.LH_STT_DEVICE;
		assert.equal(sttDevice(), "auto");
		for (const s of localSttStatuses()) assert.equal(s.repo, LOCAL_STT_MODELS[s.language].repo);
		process.env.LH_STT_DEVICE = "cpu";
		assert.equal(sttDevice(), "cpu");
		for (const s of localSttStatuses()) {
			assert.equal(s.repo, LOCAL_STT_MODELS[s.language].fallback.repo);
			assert.equal(s.sizeMb, LOCAL_STT_MODELS[s.language].fallback.sizeMb);
		}
	} finally {
		if (saved === undefined) delete process.env.LH_STT_DEVICE;
		else process.env.LH_STT_DEVICE = saved;
	}
});

test("settings line says CPU when the CPU model is the choice", () => {
	const base = { language: "en", repo: "r", sizeMb: 250 } as const;
	assert.equal(localModelLine({ ...base, state: "ready", ranOn: "cpu" }), "ready · CPU");
	assert.equal(localModelLine({ ...base, state: "ready", ranOn: "gpu" }), "ready · GPU");
});
