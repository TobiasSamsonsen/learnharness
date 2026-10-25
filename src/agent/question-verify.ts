/**
 * The answer-key check seam (owner, 2026-10-25 — core/answer-check.ts):
 * every multiple-choice question tool (the prober's and the placement
 * tester's `probe`, the teacher's `quiz`) awaits verifyQuestion after its
 * authoring contract passes, and refuses the call with what it returns.
 *
 * The server installs the real verifier (server/question-check.ts: Python
 * + a second model). Nothing installed — unit tests, the bare tool
 * registry — means no check: the tools behave exactly as before.
 */

import { coerceCorrectAnswer } from "../core/question-core.ts";
import type { FigureCheck } from "../core/figures/index.ts";

/** A question as the tools validated it. */
export interface QuizKeyInput {
	question: string;
	details?: string;
	options: ReadonlyArray<{ label: string; value?: string }>;
	correctAnswer: string | string[];
	multiSelect?: boolean;
	/** An optional Python program that prints the correct option's label. */
	verify?: string;
	/** The worked solution — it may carry figures the question references. */
	explanation?: string;
	/** An optional figure quantity the correct option states (core/figures). */
	figureCheck?: FigureCheck;
}

/** The input resolved the way grading resolves it: option keys (value, or
 *  label) and the correct options' indices. */
export interface ResolvedQuiz extends QuizKeyInput {
	keyed: Array<{ label: string; value: string }>;
	correct: number[];
}

export function resolveQuiz(input: QuizKeyInput): ResolvedQuiz {
	const keyed = input.options.map((o) => ({ label: o.label.trim(), value: o.value?.trim() || o.label.trim() }));
	const values = keyed.map((o) => o.value);
	const correct = [...new Set(coerceCorrectAnswer(input.correctAnswer, values))].map((v) => values.indexOf(v)).filter((i) => i >= 0);
	return { ...input, keyed, correct };
}

/** Problems for the author (empty = the question may be posed). */
export type QuestionVerifier = (input: ResolvedQuiz, signal?: AbortSignal) => Promise<string[]>;

let installed: QuestionVerifier | null = null;

export function installQuestionVerifier(verifier: QuestionVerifier | null): void {
	installed = verifier;
}

export async function verifyQuestion(input: QuizKeyInput, signal?: AbortSignal): Promise<string[]> {
	if (!installed) return [];
	return installed(resolveQuiz(input), signal);
}
