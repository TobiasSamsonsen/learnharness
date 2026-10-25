/**
 * The answer checker (owner, 2026-10-25): a SECOND model solves every
 * multiple-choice question before the learner sees it — blind: it gets the
 * question, the options and any Python facts, never the author's key or
 * explanation, so it cannot anchor on them. core/answer-check.ts compares
 * its answer with the key.
 *
 * One submit call (runSubmitAgent) on the `checker` role.
 */

import { Type, type Static } from "typebox";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

const INSTRUCTIONS = `You check a multiple-choice question before a learner sees it. You do NOT see the author's answer — solve the question yourself, from scratch, carefully and completely: compute every number, trace every line of code, check every claim the question makes.

Then submit:
- solution: your worked solution — short, but every step that decides the answer.
- correct: the value of EVERY option that is correct (normally exactly one).
- problem: ONLY when the question itself is broken — a false statement or premise in the question text, no option correct, several options correct in a single-select question, or an ambiguity that lets a careful solver defend another option. Leave it empty when the question is sound.

You see the raw markdown and LaTeX source; the learner sees it rendered. Formatting, escaping and notation style are never a problem — judge the content only.

Facts from running the question's code are ground truth — rely on them over your own trace.`;

export const checkSchema = Type.Object({
	solution: Type.String({ minLength: 1, description: "Your worked solution — every step that decides the answer" }),
	correct: Type.Array(Type.String(), { description: "The value of every correct option ([] if none is correct)" }),
	problem: Type.Optional(Type.String({ description: "Only when the question itself is broken; empty when it is sound" })),
});

export type CheckVerdict = Static<typeof checkSchema>;

export interface CheckInput {
	question: string;
	details?: string;
	options: ReadonlyArray<{ label: string; value: string }>;
	multiSelect: boolean;
	/** Python ground truth (core/answer-check.ts facts). */
	facts: readonly string[];
}

export function checkerPrompt(input: CheckInput): string {
	return [
		`QUESTION (${input.multiSelect ? "multi-select: every correct option must be chosen" : "single-select"}):`,
		input.question,
		...(input.details ? ["", "Shown under the question:", input.details] : []),
		"",
		"OPTIONS (value: label):",
		...input.options.map((o) => `- ${o.value}: ${o.label}`),
		...(input.facts.length > 0 ? ["", "FACTS:", ...input.facts.map((f) => `- ${f}`)] : []),
	].join("\n");
}

/** Solve one question blind. Throws when the checker never submits. */
export async function checkQuestion(input: CheckInput, deps: { engine: PiEngine | undefined; signal?: AbortSignal }): Promise<CheckVerdict> {
	return runSubmitAgent({
		role: "checker",
		toolName: "submit_check",
		toolDescription: "Submit your independent solution: the worked solution, the correct option value(s), and a problem only if the question is broken.",
		parameters: checkSchema,
		fill: (v: CheckVerdict) => ({ solution: v.solution, correct: v.correct ?? [], ...(v.problem ? { problem: v.problem } : {}) }),
		systemPrompt: INSTRUCTIONS,
		prompt: checkerPrompt(input),
		engine: deps.engine,
		signal: deps.signal,
		onStep: () => {},
		neverSubmitted: "the answer checker never submitted",
		maxTurns: 3,
	});
}
