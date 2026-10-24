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
	resolveLessonLanguage,
	withLanguageDirective,
} from "../src/core/language.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseGeneralSettingsBody, parseSettingsBody } from "../src/server/settings-body.ts";
import { createTeacherAgent, createProberAgent } from "../src/agent/teacher-agent.ts";
import { deepgramUrl, joinFrames, localStopLabel } from "../components/dictation.tsx";
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
		assert.equal(LOCAL_STT_MODELS.nb.repo, "onnx-community/nb-whisper-small-ONNX");
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
	test("Deepgram gets the lesson's language code", () => {
		assert.match(deepgramUrl("en"), /[?&]language=en&/);
		assert.match(deepgramUrl("nb"), /[?&]language=no&/);
		assert.match(deepgramUrl("nb"), /model=nova-3/);
	});

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

	test("the settings row describes each model state", () => {
		const base = { language: "en" as const, repo: "r", sizeMb: 250 };
		assert.equal(localModelLine({ ...base, state: "absent" }), "not downloaded · 250 MB");
		assert.equal(localModelLine({ ...base, state: "downloading", progress: 0.5 }), "downloading 50%");
		assert.equal(localModelLine({ ...base, state: "cached" }), "downloaded");
		assert.equal(localModelLine({ ...base, state: "error", error: "offline" }), "failed — offline");
	});
});
