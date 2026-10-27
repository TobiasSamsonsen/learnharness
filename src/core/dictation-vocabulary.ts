import { derivePlanStatusesLh, type PlanTree } from "./contracts.ts";
import type { LessonLanguage } from "./language.ts";
import type { LhMessage } from "./native-messages.ts";
import { tutorProse } from "./tutor-prose.ts";

/**
 * The dictation vocabulary prompt (Android plan M4). PURE, browser-safe.
 *
 * whisper.cpp takes a per-request `prompt` that biases Whisper toward the
 * lesson's own words ("eigenvalue", "Thévenin"). Built from the chat record
 * alone, no model call (owner, M4): the active question/problem stem, the
 * plan tree's node titles (the current node first), and the recent teacher
 * messages' terms — bold spans first, then rare words. Output: a comma list
 * in the lesson language, capped by a token budget (Whisper's prompt limit
 * is 224 tokens; the prompt also steers punctuation and casing).
 */

/** Whisper tokenises technical text and Norwegian at roughly 3 characters per token. */
const CHARS_PER_TOKEN = 3;
export const VOCABULARY_BUDGET_TOKENS = 150;
const RECENT_TEACHER_MESSAGES = 6;
const MAX_BOLD_WORDS = 4;
const QUESTION_TOOLS = new Set(["quiz", "probe", "ask_user_question", "explain", "recall"]);
const PROBLEM_TOOL = "problem";

/** Long, common words that are not vocabulary — rare-word picking skips them. */
const COMMON_LONG_WORDS: Record<LessonLanguage, ReadonlySet<string>> = {
	en: new Set(
		(
			"about actually additional already although another because becomes before between certain consider " +
			"correct currently describe different directly during either enough especially everything example " +
			"exactly following function however instead interesting literally mention mostly multiple necessary " +
			"obviously otherwise perhaps possible probably question quickly rather really related remember " +
			"result several similar simply something sometimes somewhat specific suppose therefore through " +
			"together understand usually whatever whether without"
		).split(" "),
	),
	nb: new Set(
		(
			"allerede dessuten egentlig eksempel enkelt forskjellig fortsatt forstå forstår gjennom hvordan hvorfor " +
			"imidlertid kanskje likevel nemlig noen nesten ofte oppgave oppgaven sammen spørsmål spørsmålet " +
			"vanligvis veldig viktig dermed derfor deretter fordi først hvilken hvilket innenfor mellom " +
			"mulig sannsynligvis selvfølgelig situasjon tilfelle"
		).split(" "),
	),
};

/** Approximate token count of a vocabulary string. */
export function vocabularyTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Text with math, code, links and markdown syntax removed (bold markers kept). */
function proseOf(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/\$\$[\s\S]*?\$\$/g, " ")
		.replace(/\\\[[\s\S]*?\\\]/g, " ")
		.replace(/\\\([\s\S]*?\\\)/g, " ")
		.replace(/\$[^$\n]+\$/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/\S+/g, " ");
}

function boldSpans(prose: string): string[] {
	const out: string[] = [];
	for (const m of prose.matchAll(/\*\*([^*\n]+?)\*\*/g)) {
		const span = m[1]!.trim().replace(/[:;,.!?]+$/, "");
		if (span.length < 2 || span.split(/\s+/).length > MAX_BOLD_WORDS) continue;
		if (!/\p{L}/u.test(span)) continue;
		out.push(span);
	}
	return out;
}

/** Capitalised (mid-sentence), hyphenated or long words that are not common words. */
function rareWords(prose: string, language: LessonLanguage): string[] {
	const common = COMMON_LONG_WORDS[language];
	const out: string[] = [];
	const plain = prose.replace(/\*\*/g, "");
	for (const m of plain.matchAll(/[\p{L}][\p{L}\p{N}]*(?:-[\p{L}\p{N}]+)*/gu)) {
		const word = m[0];
		if (common.has(word.toLowerCase())) continue;
		const before = plain.slice(0, m.index).trimEnd();
		const sentenceStart = before === "" || /[.!?:]$/.test(before);
		const capitalised = /^\p{Lu}\p{Ll}{3,}/u.test(word) && !sentenceStart;
		if (word.includes("-") || word.length >= 8 || capitalised) out.push(word);
	}
	return out;
}

function textOf(message: LhMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	// text blocks plus a teach question's `lead` (core/tutor-prose.ts)
	return tutorProse(content as Parameters<typeof tutorProse>[0]).join("\n");
}

/** The newest question or problem call's stem: what the learner is answering now. */
function activeStem(messages: readonly LhMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of [...(content as Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }>)].reverse()) {
			if (block.type !== "toolCall" || !block.name) continue;
			if (QUESTION_TOOLS.has(block.name)) {
				const q = block.arguments?.question;
				if (typeof q === "string") return q;
			} else if (block.name === PROBLEM_TOOL) {
				const s = block.arguments?.statement;
				if (typeof s === "string") return s;
			}
		}
	}
	return "";
}

function stemTerms(stem: string, language: LessonLanguage): string[] {
	const prose = proseOf(stem);
	return [...boldSpans(prose), ...rareWords(prose, language)];
}

function teacherTerms(messages: readonly LhMessage[], language: LessonLanguage): string[] {
	const recent: string[] = [];
	for (let i = messages.length - 1; i >= 0 && recent.length < RECENT_TEACHER_MESSAGES; i--) {
		const m = messages[i]!;
		if ((m as { role?: string }).role !== "assistant") continue;
		const text = textOf(m);
		if (text.trim()) recent.push(proseOf(text)); // newest first
	}
	// bold spans of every recent message come before any rare word
	return [...recent.flatMap(boldSpans), ...recent.flatMap((p) => rareWords(p, language))];
}

function planTitles(tree: PlanTree | undefined, messages: readonly LhMessage[]): string[] {
	if (!tree || tree.nodes.length === 0) return [];
	const { current } = derivePlanStatusesLh(tree, messages);
	const titles = tree.nodes.map((n) => n.title.trim()).filter(Boolean);
	const currentTitle = tree.nodes.find((n) => n.id === current)?.title.trim();
	return currentTitle ? [currentTitle, ...titles.filter((t) => t !== currentTitle)] : titles;
}

export interface VocabularySource {
	messages: readonly LhMessage[];
	tree?: PlanTree;
	language: LessonLanguage;
}

/** The comma list sent as whisper.cpp's `prompt` — empty when the lesson has no terms yet. */
export function dictationVocabulary(source: VocabularySource, budgetTokens: number = VOCABULARY_BUDGET_TOKENS): string {
	const { messages, tree, language } = source;
	const candidates = [
		...stemTerms(activeStem(messages), language),
		...planTitles(tree, messages),
		...teacherTerms(messages, language),
	];
	const budgetChars = budgetTokens * CHARS_PER_TOKEN - 1; // the closing "."
	const terms: string[] = [];
	let joined = "";
	for (const raw of candidates) {
		const term = raw.replace(/\s+/g, " ").trim();
		if (!term) continue;
		const lower = term.toLowerCase();
		// already listed, or a word of a phrase already listed
		if (` ${joined.toLowerCase()} `.replace(/[,]/g, " ").includes(` ${lower} `)) continue;
		const next = joined ? `${joined}, ${term}` : term;
		if (next.length > budgetChars) continue; // a shorter later term may still fit
		terms.push(term);
		joined = next;
	}
	return terms.length > 0 ? `${joined}.` : "";
}

function wordsOf(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Whisper sometimes answers an unclear clip with its own prompt. A transcript
 *  that is a contiguous run of three or more words of the vocabulary is that
 *  echo (a learner saying three terms in exactly the list's order is not
 *  speech worth keeping): it becomes silence. One or two terms stay. */
export function dropPromptEcho(text: string, vocabulary: string): string {
	const said = wordsOf(text);
	if (said.length < 3) return text;
	const listed = wordsOf(vocabulary);
	for (let at = listed.indexOf(said[0]!); at !== -1; at = listed.indexOf(said[0]!, at + 1)) {
		if (said.every((w, i) => listed[at + i] === w)) return "";
	}
	return text;
}
