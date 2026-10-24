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

/** The local speech-to-text model per language — chosen by benchmark on
 *  FLEURS (2026-10-24): the National Library's nb-whisper is ~6× more
 *  accurate on Norwegian than multilingual whisper-small (6% vs 36% WER),
 *  which in turn is far better on English. Both quantized (q8), ~2s per
 *  10s of speech on a laptop CPU. */
export interface LocalSttModel {
	language: LessonLanguage;
	repo: string;
	/** Download size, for the settings row. */
	sizeMb: number;
}

export const LOCAL_STT_MODELS: Record<LessonLanguage, LocalSttModel> = {
	en: { language: "en", repo: "onnx-community/whisper-small", sizeMb: 250 },
	nb: { language: "nb", repo: "onnx-community/nb-whisper-small-ONNX", sizeMb: 410 },
};

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
}
