/**
 * Lesson languages (fork addition, 2026-10-24). PURE, browser-safe.
 *
 * Every lesson carries a language (ChatSettings.language), stamped at
 * birth from the default (GeneralSettings.language). It steers two
 * things: what the agents write (the directives below, appended to the
 * conversation, extraction and artifact prompts) and what dictation
 * transcribes (the per-engine codes here).
 *
 * Every language, English included, gets a directive: a lesson can switch
 * language midway, and without an explicit English line the model just
 * follows the transcript's earlier language (caught live, 2026-10-24).
 */

export type LessonLanguage = "en" | "nb";

export interface LessonLanguageInfo {
	id: LessonLanguage;
	/** The picker label, in the language itself. */
	label: string;
	/** The two-letter pill on the stats bar. */
	short: string;
	/** How the prompts name it to the model. */
	promptName: string;
	/** Whisper's language name (local dictation). */
	whisper: string;
	/** Deepgram's language code (cloud dictation). */
	deepgram: string;
}

export const LESSON_LANGUAGES: readonly LessonLanguageInfo[] = [
	{ id: "en", label: "English", short: "EN", promptName: "English", whisper: "english", deepgram: "en" },
	{ id: "nb", label: "Norsk (bokmål)", short: "NO", promptName: "Norwegian Bokmål", whisper: "norwegian", deepgram: "no" },
] as const;

export const DEFAULT_LESSON_LANGUAGE: LessonLanguage = "en";

export function isLessonLanguage(value: unknown): value is LessonLanguage {
	return LESSON_LANGUAGES.some((l) => l.id === value);
}

export function lessonLanguageInfo(id: LessonLanguage): LessonLanguageInfo {
	return LESSON_LANGUAGES.find((l) => l.id === id) ?? LESSON_LANGUAGES[0]!;
}

/** A lesson's language: its own stamp, else English. Lessons born before
 *  languages existed were all taught in English, so a missing stamp means
 *  English — never the CURRENT default, which would switch a running
 *  lesson's language under it. */
export function resolveLessonLanguage(settings: { language?: LessonLanguage } | undefined): LessonLanguage {
	return settings?.language ?? DEFAULT_LESSON_LANGUAGE;
}

/** Which prompt family a directive is for. */
export type LanguageDirectiveRole = "conversation" | "extraction" | "artifact";

/** The system-prompt paragraph that makes an agent work in the lesson's
 *  language. */
export function languageDirective(language: LessonLanguage, role: LanguageDirectiveRole): string {
	const name = lessonLanguageInfo(language).promptName;
	const body =
		role === "conversation"
			? `Conduct this entire lesson in ${name}. Everything the learner can see must be in ${name}: your messages, questions, answer options, explanations, hints, plan node labels and every other learner-facing tool argument. The lesson's language can be changed while it runs: if earlier messages are in another language, continue in ${name} from now on. Answer in ${name} even when the learner writes or dictates in another language or mixes in terms from one, unless they explicitly ask you to switch. Keep mathematical notation, code and established technical symbols as they are.`
			: role === "extraction"
				? `The session was taught in ${name}. Write every proposition's name, statement and aliases in ${name}, as the lesson phrased them.`
				: `The lesson this is for is taught in ${name}. Write all learner-visible text — titles, labels, captions, buttons, legends and explanations — in ${name}.`;
	return `<lesson_language>\n${body}\n</lesson_language>`;
}

/** Append the lesson's language directive to a system prompt. */
export function withLanguageDirective(systemPrompt: string, language: LessonLanguage, role: LanguageDirectiveRole): string {
	return `${systemPrompt}\n\n${languageDirective(language, role)}`;
}

// ─── dictation ───────────────────────────────────────────────────────────────

/** Where dictation runs: on this machine (default) or Deepgram's cloud. */
export type DictationEngine = "local" | "deepgram";

export const DEFAULT_DICTATION_ENGINE: DictationEngine = "local";

export function isDictationEngine(value: unknown): value is DictationEngine {
	return value === "local" || value === "deepgram";
}

/** How a local speech model's weights are stored — transformers.js picks
 *  the ONNX files by it (sttModelFiles). */
export type SttDtype = "q8" | "q4" | "fp16";

/** One runnable local speech model: weights + where they run. */
export interface SttModelSpec {
	repo: string;
	dtype: SttDtype;
	/** webgpu: the GPU (onnxruntime-node's WebGPU provider — on a hybrid
	 *  laptop it takes the discrete GPU) · cpu: the processor. */
	device: "webgpu" | "cpu";
	/** Download size, for the settings row. */
	sizeMb: number;
}

/** The local speech-to-text models per language (owner, 2026-10-25 —
 *  benchmarked on 99 s of FLEURS nb_no on an RTX 5060 laptop): the
 *  National Library's NB-Whisper LARGE on the GPU has ~30% fewer word
 *  errors than the small model (5.7% vs 8.0% WER) at about the small
 *  model's old CPU speed; English gets Whisper large-v3-turbo (a large
 *  encoder with a 4-layer decoder) on the GPU. When the GPU path cannot
 *  run, the worker falls back to the previous small q8 models on the CPU
 *  (~17 s per 100 s of speech). The top-level fields are the GPU model. */
export interface LocalSttModel extends SttModelSpec {
	language: LessonLanguage;
	fallback: SttModelSpec;
}

export const LOCAL_STT_MODELS: Record<LessonLanguage, LocalSttModel> = {
	en: {
		language: "en",
		repo: "onnx-community/whisper-large-v3-turbo",
		dtype: "fp16",
		device: "webgpu",
		sizeMb: 1620,
		fallback: { repo: "onnx-community/whisper-small", dtype: "q8", device: "cpu", sizeMb: 250 },
	},
	nb: {
		language: "nb",
		repo: "Hjertelig/nb-whisper-large-ONNX",
		dtype: "q4",
		device: "webgpu",
		sizeMb: 1260,
		fallback: { repo: "onnx-community/nb-whisper-small-ONNX", dtype: "q8", device: "cpu", sizeMb: 410 },
	},
};

/** Which local speech engine runs (LH_STT_ENGINE, Android plan M4):
 *  transformers.js in a worker (the desktop default) or a whisper.cpp
 *  `whisper-server` (the Android path; also runnable on the desktop). */
export type SttEngine = "transformers" | "whispercpp";

export const DEFAULT_STT_ENGINE: SttEngine = "transformers";

/** An unset or unknown LH_STT_ENGINE value is the default engine. */
export function parseSttEngine(value: string | undefined): SttEngine {
	return value?.trim().toLowerCase() === "whispercpp" ? "whispercpp" : DEFAULT_STT_ENGINE;
}

/** One GGML model for the whisper.cpp engine: a file in a Hugging Face repo.
 *  PROVISIONAL (Android plan M4): the defaults are fixed by the bench
 *  (docs/android/stt-bench.md), not guessed. */
export interface WhisperCppModel {
	language: LessonLanguage;
	repo: string;
	/** The file in the repo; also its name on disk under <data>/models/stt/ggml. */
	file: string;
	/** Whisper's language code for the request's `language` field. */
	code: string;
	sizeMb: number;
}

export const WHISPERCPP_MODELS: Record<LessonLanguage, WhisperCppModel> = {
	en: { language: "en", repo: "ggerganov/whisper.cpp", file: "ggml-large-v3-turbo-q5_0.bin", code: "en", sizeMb: 574 },
	nb: { language: "nb", repo: "NbAiLab/nb-whisper-small", file: "ggml-model-q5_0.bin", code: "no", sizeMb: 175 },
};

const DTYPE_SUFFIX: Record<SttDtype, string> = { q8: "_quantized", q4: "_q4", fp16: "_fp16" };

/** The files a model needs on disk (transformers.js's naming by dtype). */
export function sttModelFiles(dtype: SttDtype): string[] {
	const s = DTYPE_SUFFIX[dtype];
	return [`onnx/encoder_model${s}.onnx`, `onnx/decoder_model_merged${s}.onnx`, "tokenizer.json"];
}

/** One local model's state, as GET /api/stt/local reports it. */
export interface LocalSttStatus {
	language: LessonLanguage;
	repo: string;
	sizeMb: number;
	/** absent: not downloaded · downloading: fetching (progress 0..1) ·
	 *  loading: on disk, loading into memory · cached: on disk, not loaded ·
	 *  ready: loaded and warm · error: the last attempt failed. */
	state: "absent" | "downloading" | "loading" | "cached" | "ready" | "error";
	progress?: number;
	error?: string;
	/** Where the last transcription or warm-up ran: the GPU model, or the
	 *  CPU fallback. Absent until one has run in this server process. */
	ranOn?: "gpu" | "cpu-fallback";
}
