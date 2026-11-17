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
 *  prediction (it comes before the teaching), the final problem and the recall opener (unaided), the probe, or an open-ended ask. */
export function hintEligible(tool: string, input: unknown, phase: string): boolean {
	if (phase !== "teach" || (tool !== "quiz" && tool !== "explain")) return false;
	const type = normalizeQuizType((input as { type?: unknown } | null)?.type);
	return type !== "predict" && type !== "final" && type !== "recall";
}

/** The line a hint request adds when the learner's current handwriting rides along as an image (owner, 2026-11-17). */
export const HINT_INK_LINE =
	"An image of the learner's CURRENT handwriting on this problem is attached. Read it first and fit the hint to where they are: what they have already done, and where they stopped or went wrong. Do not transcribe it, grade it, or say whether it is right.";

/** The instruction appended to the history as the hint call's one user message. `n` = which hint this is (1-based). */
export function hintPrompt(input: { n: number; earlier: readonly string[]; thinking?: string; ink?: boolean }): string {
	const lines = [
		`[HINT REQUEST — NOT AN ANSWER] The learner has not answered your pending question. They ask for hint ${input.n} of ${HINT_MAX}. Give exactly one hint at this level:`,
		"1: where to look (the part of the problem or of their own work to look at again). Name no rule.",
		"2: the idea, rule or definition that applies, named, and why it applies here.",
		"3: the move outlined in words: what to do, in order, without doing it.",
		"Never a worked step, a number or expression from the answer, or which option is right or wrong. Do not repeat an earlier hint. Two or three sentences.",
		"Reply with the hint only, as plain text (no tool calls, no preamble).",
	];
	if (input.ink) lines.push("", HINT_INK_LINE);
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

// ─── practice hints: sized, recorded in the chat, capped in the grade (owner, 2026-11-17) ──────────────────────────

/** How much a practice hint carried the learner: a slip (a sign, a copying error), a nudge in the right direction, a carry forward. */
export const HINT_SIZES = ["slip", "nudge", "carry"] as const;
export type HintSize = (typeof HINT_SIZES)[number];
/** What the grader names for one skill once it has weighed every hint (button and chat): the strongest effect on that skill. */
export type HintWeight = "none" | HintSize;
export const HINT_WEIGHTS: readonly HintWeight[] = ["none", ...HINT_SIZES];
/** The size recorded when the model's label is missing or unreadable (owner: nudge). */
export const HINT_SIZE_FALLBACK: HintSize = "nudge";

const GRADE_ORDER = ["again", "hard", "good", "easy"] as const;
type CappedGrade = (typeof GRADE_ORDER)[number];

/** The highest grade a skill can earn at each hint weight (owner: nudge → at most Good, carry → at most Hard; a slip costs nothing). */
export const HINT_GRADE_CAP: Record<HintWeight, CappedGrade | null> = { none: null, slip: null, nudge: "good", carry: "hard" };

/** The grade after the hint cap: never above the cap, never raised. An unknown weight leaves the grade alone. */
export function capGradeByHint<G extends CappedGrade>(grade: G, weight: HintWeight | undefined): CappedGrade {
	const cap = weight ? HINT_GRADE_CAP[weight] : null;
	if (!cap) return grade;
	return GRADE_ORDER.indexOf(grade) > GRADE_ORDER.indexOf(cap) ? cap : grade;
}

export function isHintWeight(value: unknown): value is HintWeight {
	return typeof value === "string" && (HINT_WEIGHTS as readonly string[]).includes(value);
}

/** The customType of the chat-record marker a practice hint leaves (core/native-messages.ts newPracticeHintMarker). */
export const PRACTICE_HINT_MARKER = "practice-hint";

/** A practice problem takes the Hint button. Every posed practice problem does today; this is the one place a kind that must stay
 *  unaided (an exam simulation, a retest, a missed-problem variant) is excluded when the pose says so. */
export function practiceHintEligible(problemInput: unknown): boolean {
	return problemInput !== null && typeof problemInput === "object";
}

/** The instruction for a practice hint: the tutor picks the smallest hint that unblocks the learner, and labels its size. */
export function practiceHintPrompt(input: { n: number; earlier: readonly { size: HintSize; text: string }[]; thinking?: string; ink?: boolean }): string {
	const lines = [
		`[HINT REQUEST — NOT AN ANSWER] The learner has not answered the open practice problem. They ask for a hint (${input.n} of ${HINT_MAX}). Give the SMALLEST hint that unblocks them, judged from where they are stuck (their typed work and handwriting, if any). Label its size:`,
		"slip: they made a small mechanical slip (a dropped sign, an arithmetic or copying error, a misread symbol): point at where to look. Name no rule.",
		"nudge: they need a push in the right direction: the idea, rule or part of the problem to rethink, without the step itself.",
		"carry: they are stuck so hard that only the next move will carry them forward: outline it in words, without doing it.",
		"Start low. Go up a size only when the learner is plainly still stuck after the earlier hints.",
		"Never the committed solution, the final answer, a number or expression from it, or whether their work is right. Do not repeat an earlier hint. Two or three sentences.",
		"Reply in exactly this form, plain text, no tool calls: a first line `SIZE: slip`, `SIZE: nudge` or `SIZE: carry`, then the hint on the following lines.",
	];
	if (input.ink) lines.push("", HINT_INK_LINE);
	if (input.earlier.length > 0) {
		lines.push("", "Hints already given on this problem:");
		input.earlier.forEach((h, i) => lines.push(`${i + 1} (${h.size}): ${h.text}`));
	}
	const thinking = input.thinking?.trim();
	if (thinking) lines.push("", `What the learner has typed so far (their thinking, not an answer): ${thinking}`);
	return lines.join("\n");
}

/** Split a practice hint reply into its size and text. A missing or unreadable label records the fallback size (`labelled` false);
 *  a first line that names a size is stripped either way. */
export function parseHintReply(reply: string): { size: HintSize; text: string; labelled: boolean } {
	const trimmed = reply.trim();
	const m = /^\s*\**\s*SIZE\s*:\s*([A-Za-z]+)\s*\**[^\S\n]*(?:\n|$)/i.exec(trimmed);
	if (!m) return { size: HINT_SIZE_FALLBACK, text: trimmed.slice(0, HINT_TEXT_MAX), labelled: false };
	const word = m[1]!.toLowerCase();
	const size = (HINT_SIZES as readonly string[]).includes(word) ? (word as HintSize) : null;
	return { size: size ?? HINT_SIZE_FALLBACK, text: trimmed.slice(m[0].length).trim().slice(0, HINT_TEXT_MAX), labelled: size !== null };
}

/** The model-facing text of a practice hint's chat marker: what the learner was told, and what it means for concluding. */
export function practiceHintMarkerText(input: { n: number; size: HintSize; text: string }): string {
	const effect =
		input.size === "slip"
			? "A slip-sized hint does not make this a hinted solve: conclude as solved if nothing else was hinted."
			: "This is a real hint: conclude a solve as solvedWithHints. The grader weighs it with every other hint on each skill.";
	return `[The learner pressed Hint (${input.n} of ${HINT_MAX} on this problem); a hint of size ${input.size} was given: «${input.text}». ${effect} Do not repeat it; build on it.]`;
}

/** The button hints already recorded for one practice problem, oldest first. */
export function practiceHintsOf(messages: readonly unknown[], problemCallId: string): { size: HintSize; text: string }[] {
	const out: { size: HintSize; text: string }[] = [];
	for (const m of messages) {
		const marker = m as { role?: string; customType?: string; details?: { problemCallId?: unknown; size?: unknown; text?: unknown } } | null;
		if (marker?.role !== "custom" || marker.customType !== PRACTICE_HINT_MARKER) continue;
		const d = marker.details;
		if (d?.problemCallId !== problemCallId || typeof d.text !== "string") continue;
		out.push({ size: (HINT_SIZES as readonly string[]).includes(d.size as string) ? (d.size as HintSize) : HINT_SIZE_FALLBACK, text: d.text });
	}
	return out;
}

/** What a conclude may not say, given the button hints on its problem (returned as the refusal's reasons; empty = fine).
 *  A nudge or carry makes a solve a hinted solve; slips alone, with no hint from the tutor (`rung` null), do not. */
export function hintOutcomeProblems(outcome: string, rung: string | null, hints: readonly { size: HintSize }[]): string[] {
	if (hints.length === 0) return [];
	const real = hints.some((h) => h.size !== "slip");
	if (outcome === "solved" && real) return ["the learner took a nudge- or carry-sized hint with the Hint button on this problem: conclude a solve as solvedWithHints, not solved"];
	if (outcome === "solvedWithHints" && !real && rung === null) return ["the learner took only slip-sized hints (a missed sign, a copying error) and you gave no hint yourself: that is not a hinted solve, conclude it as solved"];
	return [];
}
