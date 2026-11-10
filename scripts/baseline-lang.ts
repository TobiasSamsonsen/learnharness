/**
 * baseline-lang.ts — the language-dependent and pure parts of scripts/tutor-baseline.ts, kept apart so tests can import
 * them (tutor-baseline.ts runs a lesson the moment it is loaded).
 *
 * Owner decisions (2026-11-10): the nb run uses a Norwegian scripted learner (a per-language table of the learner's
 * lines; the `en` table is byte-identical to the old hard-coded strings so old runs stay comparable); the report gains
 * a praise/filler counter and, for nb, an English-leak estimate over the tutor's prose; and `--compare a.json b.json`
 * prints the two reports side by side. The Norwegian lines and both word lists are drafts awaiting the owner's review.
 */

export type BaselineLanguage = "en" | "nb";

// ---- the scripted learner's lines ------------------------------------------------------------------------------

export interface LearnerLines {
	/** The topic used when --topic is not given. */
	defaultTopic: string;
	/** The first message, about the topic. */
	opening: (topic: string) => string;
	/** After a turn that ended on text (the plan, a closing line): the learner goes on. */
	start: string;
	/** A correct pick with low confidence and a stated "I don't understand". */
	confused: string;
	/** The reasoning given with a wrong answer. */
	guessing: string;
	/** The reasoning given with any other answer. */
	followsFromSaid: string;
	/** The reasoning at a plan-phase question. */
	planOk: string;
	/** A free-text answer to an open ask. */
	yesGoOn: string;
	/** A wrong free-text answer to an explain / recall. */
	wrongExplain: string;
	/** An explain / recall answer when the tutor committed to nothing to copy. */
	bestAttempt: string;
}

const LEARNER_LINES: Record<BaselineLanguage, LearnerLines> = {
	en: {
		defaultTopic: "the epsilon-delta definition of a limit",
		opening: (topic) => `I want to learn ${topic}.`,
		start: "Looks good, let's start.",
		confused: "I picked it, but honestly I do not understand why it is true. I am not sure what this means.",
		guessing: "I am guessing here.",
		followsFromSaid: "That follows from what was said.",
		planOk: "ok",
		yesGoOn: "Yes, go on.",
		wrongExplain: "I think it is the other way round, but I cannot say why.",
		bestAttempt: "My best attempt.",
	},
	nb: {
		defaultTopic: "ε-δ-definisjonen av en grenseverdi",
		opening: (topic) => `Jeg vil lære ${topic}.`,
		start: "Ser bra ut, la oss begynne.",
		confused: "Jeg valgte det, men jeg forstår ærlig talt ikke hvorfor det stemmer. Jeg er usikker på hva det betyr.",
		guessing: "Jeg gjetter bare her.",
		followsFromSaid: "Det følger av det som ble sagt.",
		planOk: "ok",
		yesGoOn: "Ja, fortsett.",
		wrongExplain: "Jeg tror det er motsatt, men jeg kan ikke si hvorfor.",
		bestAttempt: "Mitt beste forsøk.",
	},
};

export function learnerLines(language: string): LearnerLines {
	const lines = (LEARNER_LINES as Record<string, LearnerLines | undefined>)[language];
	if (!lines) throw new Error(`no learner lines for language "${language}" (have: ${Object.keys(LEARNER_LINES).join(", ")})`);
	return lines;
}

// ---- the tutor's prose -----------------------------------------------------------------------------------------

/** What reached the learner as the tutor's own words: assistant text blocks, a question's `lead`, a send_to_user `message`. */
export function tutorProse(messages: readonly unknown[]): string[] {
	const out: string[] = [];
	for (const m of messages as Array<{ role?: string; content?: unknown }>) {
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content as Array<Record<string, any>>) {
			if (b?.type === "text" && typeof b.text === "string") out.push(b.text);
			else if (b?.type === "toolCall") {
				if (typeof b.arguments?.lead === "string") out.push(b.arguments.lead);
				if (b.name === "send_to_user" && typeof b.arguments?.message === "string") out.push(b.arguments.message);
			}
		}
	}
	return out.map((t) => t.trim()).filter((t) => t.length > 0);
}

// ---- praise / filler -------------------------------------------------------------------------------------------

/** The voice rules delete praise and performed reaction ("Not 'great question.' Not 'excellent.'"). Matched whole-word, case-insensitive. */
export const FILLER_TERMS: Record<BaselineLanguage, string[]> = {
	en: ["great question", "good question", "great job", "good job", "nice work", "nice job", "well done", "spot on", "great", "excellent", "awesome", "fantastic", "wonderful", "perfect", "impressive"],
	nb: ["godt spørsmål", "bra spørsmål", "flott spørsmål", "bra jobbet", "bra gjort", "godt gjort", "flott", "utmerket", "supert", "kjempebra", "fantastisk", "strålende", "imponerende", "perfekt"],
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** \b does not know æøå, so the word edges are Unicode letter lookarounds. */
const termRe = (term: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");

export interface FillerCount {
	total: number;
	byTerm: Record<string, number>;
}

export function countFiller(texts: readonly string[], language: string): FillerCount {
	const terms = (FILLER_TERMS as Record<string, string[] | undefined>)[language] ?? [];
	const byTerm: Record<string, number> = {};
	let total = 0;
	// longest terms first, and a matched span is blanked so "great question" is not also counted as "great"
	for (let text of texts) {
		for (const term of [...terms].sort((a, b) => b.length - a.length)) {
			text = text.replace(termRe(term), () => {
				byTerm[term] = (byTerm[term] ?? 0) + 1;
				total++;
				return " ";
			});
		}
	}
	return { total, byTerm };
}

// ---- English leaking into a Norwegian lesson -------------------------------------------------------------------

/** Function words that settle a sentence's language. Words that are real in both (to, is, her, men, for, at, so) are left out. */
const EN_WORDS = new Set(["the", "are", "was", "were", "of", "and", "that", "this", "these", "those", "it", "its", "with", "which", "what", "you", "your", "we", "if", "then", "from", "can", "have", "has", "because", "not", "but", "do", "does", "will", "would", "should", "how", "why", "when", "there", "here", "an"]);
const NB_WORDS = new Set(["og", "er", "det", "som", "ikke", "til", "på", "med", "av", "en", "et", "har", "vi", "du", "deg", "hva", "hvis", "så", "den", "de", "dette", "disse", "fra", "kan", "fordi", "vil", "skal", "hvordan", "hvorfor", "når", "der", "å", "om", "også", "blir", "ble", "var", "jeg", "oss"]);

/** Code, math and links are the same in every language: drop them before judging a sentence. */
export function stripNonProse(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/\$\$[\s\S]*?\$\$/g, " ")
		.replace(/\$[^$\n]*\$/g, " ")
		.replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, " ")
		.replace(/https?:\/\/\S+/g, " ");
}

export function sentencesOf(text: string): string[] {
	return stripNonProse(text)
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export interface LeakEstimate {
	/** Sentences with at least five words: the ones that can be judged. */
	sentences: number;
	/** Of those, the ones that read as English. */
	flagged: number;
	share: number | null;
	/** Up to five flagged sentences, to read by eye. */
	samples: string[];
}

/** A heuristic, not a verdict: a sentence of five or more words whose function words are English and not Norwegian. Only meaningful for nb; null otherwise. */
export function englishLeak(texts: readonly string[], language: string): LeakEstimate | null {
	if (language !== "nb") return null;
	let sentences = 0;
	let flagged = 0;
	const samples: string[] = [];
	for (const text of texts) {
		for (const s of sentencesOf(text)) {
			const words = (s.toLowerCase().match(/\p{L}+/gu) ?? []).filter((w) => w.length > 0);
			if (words.length < 5) continue;
			sentences++;
			const en = words.filter((w) => EN_WORDS.has(w)).length;
			const nb = words.filter((w) => NB_WORDS.has(w)).length;
			if (en >= 2 && en >= 2 * nb) {
				flagged++;
				if (samples.length < 5) samples.push(s.slice(0, 160));
			}
		}
	}
	return { sentences, flagged, share: sentences > 0 ? Math.round((flagged / sentences) * 1000) / 1000 : null, samples };
}

// ---- comparing two reports -------------------------------------------------------------------------------------

type Report = Record<string, any>;

const show = (v: unknown): string => (v === null || v === undefined ? "–" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));
const delta = (a: unknown, b: unknown): string => {
	if (typeof a !== "number" || typeof b !== "number") return "";
	const d = Math.round((b - a) * 1000) / 1000;
	return d > 0 ? `+${d}` : String(d);
};

/** A side-by-side table of two --out reports; the delta column is b − a. Fields an older report lacks show as –. */
export function formatComparison(a: Report, b: Report, nameA: string, nameB: string): string {
	const gates = [...new Set([...Object.keys(a.refusals ?? {}), ...Object.keys(b.refusals ?? {})])].sort();
	const rows: Array<[string, unknown, unknown]> = [
		["language", a.language, b.language],
		["thinking", a.thinking, b.thinking],
		["model", a.model, b.model],
		["questions", a.questions, b.questions],
		["avg prose chars after a miss", a.avgProseCharsAfterMiss, b.avgProseCharsAfterMiss],
		["avg prose chars after confused", a.avgProseCharsAfterConfused, b.avgProseCharsAfterConfused],
		["avg prose chars after right", a.avgProseCharsAfterRight, b.avgProseCharsAfterRight],
		["avg seconds per turn", a.avgSecondsPerTurn, b.avgSecondsPerTurn],
		...gates.map((g): [string, unknown, unknown] => [`refused: ${g}`, a.refusals ? (a.refusals[g] ?? 0) : undefined, b.refusals ? (b.refusals[g] ?? 0) : undefined]),
		["other tool errors", a.otherErrors, b.otherErrors],
		["picture jobs", a.pictureJobs, b.pictureJobs],
		["duplicate picture jobs", a.duplicateJobs, b.duplicateJobs],
		["picture before first question", a.pictureBeforeFirstTeachQuestion, b.pictureBeforeFirstTeachQuestion],
		["tutor prose chars (total)", a.proseCharsTotal, b.proseCharsTotal],
		["praise/filler hits", a.fillerHits, b.fillerHits],
		["praise/filler per 1k chars", a.fillerPer1kChars, b.fillerPer1kChars],
		["English-leak sentences (nb)", a.englishLeak?.flagged, b.englishLeak?.flagged],
		["English-leak share (nb)", a.englishLeak?.share, b.englishLeak?.share],
	];
	const table = rows.map(([label, x, y]) => [label, show(x), show(y), delta(x, y)]);
	const widths = [0, 1, 2, 3].map((i) => Math.max(...table.map((r) => (r[i] ?? "").length), ["metric", nameA, nameB, "Δ (b − a)"][i]!.length));
	const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
	const out = [line(["metric", nameA, nameB, "Δ (b − a)"]), line(widths.map((w) => "-".repeat(w))), ...table.map(line)];
	for (const [name, r] of [[nameA, a], [nameB, b]] as const) {
		const samples: string[] = r.englishLeak?.samples ?? [];
		if (samples.length > 0) out.push("", `English-looking sentences in ${name}:`, ...samples.map((s) => `  - ${s}`));
	}
	return out.join("\n");
}
