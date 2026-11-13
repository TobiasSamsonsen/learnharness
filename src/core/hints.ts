/**
 * hints — the Hint button on a lesson question (owner, 2026-11-13). The hint
 * ladder existed only in practice; in lessons the learner sat stuck (two
 * questions on the tablet ended wrong and "don't know" after a long time).
 * A lesson check now offers up to three hints that never give the answer.
 *
 * A hint is ONE separate text-only call on the chat's own model, with the
 * lesson so far (server/hint.ts, the clarification call's twin): the question
 * stays open, with the learner's thinking and sketch untouched. The hints
 * ride the answer (`hints`), so the tutor knows the answer was not unaided.
 * Pure: eligibility, the instruction texts (owner-approved), sanitizing.
 */

import { normalizeQuizType } from "./question-core.ts";

/** Hints per question: where to look, the idea named, the move outlined. Never the answer. */
export const HINT_MAX = 3;
/** A stored hint's length cap (a hint is two or three sentences). */
export const HINT_TEXT_MAX = 1200;
/** The learner's typed thinking sent with a hint request, capped. */
export const HINT_THINKING_MAX = 4000;
/** Time on one open question, with the app on screen, before the Hint button is highlighted. */
export const HINT_NUDGE_MS = 5 * 60_000;

/** Is the Hint button offered on this pending question? Lesson CHECKS only (multiple choice and free-form): never a
 *  prediction (it comes before the teaching), the final problem (unaided), the probe, or an open-ended ask. */
export function hintEligible(tool: string, input: unknown, phase: string): boolean {
	if (phase !== "teach" || (tool !== "quiz" && tool !== "explain")) return false;
	const type = normalizeQuizType((input as { type?: unknown } | null)?.type);
	return type !== "predict" && type !== "final";
}

/** The instruction appended to the history as the hint call's one user message. `n` = which hint this is (1-based). */
export function hintPrompt(input: { n: number; earlier: readonly string[]; thinking?: string }): string {
	const lines = [
		`[HINT REQUEST — NOT AN ANSWER] The learner has not answered your pending question. They ask for hint ${input.n} of ${HINT_MAX}. Give exactly one hint at this level:`,
		"1: where to look (the part of the problem or of their own work to look at again). Name no rule.",
		"2: the idea, rule or definition that applies, named, and why it applies here.",
		"3: the move outlined in words: what to do, in order, without doing it.",
		"Never a worked step, a number or expression from the answer, or which option is right or wrong. Do not repeat an earlier hint. Two or three sentences.",
		"Reply with the hint only, as plain text (no tool calls, no preamble).",
	];
	if (input.earlier.length > 0) {
		lines.push("", "Hints already given on this question:");
		input.earlier.forEach((h, i) => lines.push(`${i + 1}: ${h}`));
	}
	const thinking = input.thinking?.trim();
	if (thinking) lines.push("", `What the learner has written so far (their thinking, not an answer): ${thinking}`);
	return lines.join("\n");
}

/** What the tutor is told with an answer that took hints. */
export function hintsNextText(n: number): string {
	return `He took ${n} hint${n === 1 ? "" : "s"} on this question (in \`hints\`), so the answer is not unaided. Do not re-teach what the hints already said. Before moving on from this step, check it once more on a fresh case, without hints.`;
}

/** The hints on an answer record (or a request body): strings only, trimmed, capped in length and number. */
export function hintsOf(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((h): h is string => typeof h === "string" && h.trim() !== "")
		.map((h) => h.trim().slice(0, HINT_TEXT_MAX))
		.slice(0, HINT_MAX);
}
