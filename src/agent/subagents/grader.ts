/**
 * The practice grader (owner, 2026-11-09): a SECOND model grades each tagged
 * skill of a concluded problem from its whole transcript, so the tutor does
 * not grade its own teaching (the first review it graded `good` after three
 * nudges and a hint-fixed error). core/practice-grading.ts slices and renders
 * the evidence; core/mastery.ts folds the grades into understanding.
 *
 * One submit call (runSubmitAgent) on the `grader` role. The rubric below is
 * the owner-approved text; it is code, not an editable prompt fragment.
 */

import { Type, type Static } from "typebox";
import type { Grade } from "../../core/mastery.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

const INSTRUCTIONS = `You grade how well a learner used each skill on ONE practice problem, after it ended. You did not tutor them. Grade only from the transcript, per skill: again < hard < good < easy, never more than the learner demonstrated.

Who did the work decides: a tutor message that points at where the work is wrong or at what to do next is a hint, even a gentle one.

- AGAIN: the skill did not come back (the correction was given, they gave up, or a break was left standing).
- HARD: they got there, but not alone on this skill: a hint that led to fixing an error in it, a nudge needed for a step, a wrong step that stood until the tutor pointed at it, or stalled or copy-only first attempts.
- GOOD: they retrieved and used the skill on their own. A slip they caught themselves before any tutor remark does not lower this.
- EASY: immediate and fluent, correct the first time with no hint and no hesitation on this skill. Answering exactly what the question asked is enough; going beyond it is never required. Use it for a clean, confident solve, not for a merely adequate one.

Several skills: grade each on its own evidence. A hint spent on one skill lowers only that skill. A skill the work never exercised is hard at most.

A clean solve of a Long or Exam problem is stronger evidence than a clean solve of a Short one.

The learner's stated confidence is only a tie-breaker (low confidence with shaky work leans hard), never a grade by itself.

The transcript shows the tutor's own conclusion; weigh it as one account of what happened, not as the grade. Submit exactly one entry for every skill listed.`;

export const gradeSchema = Type.Object({
	grades: Type.Array(
		Type.Object({
			skill: Type.String({ description: "A skill id from the list." }),
			grade: Type.Union([Type.Literal("again"), Type.Literal("hard"), Type.Literal("good"), Type.Literal("easy")], { description: "again, hard, good or easy — bare word, no quotes." }),
		}),
		{ description: "One entry for every listed skill." },
	),
});

export type GradeVerdict = Static<typeof gradeSchema>;

export interface GradeInput {
	skills: ReadonlyArray<{ id: string; name: string }>;
	/** core/practice-grading renderProblemSpan. */
	transcript: string;
	/** The session's problem size, when it has one (core/difficulty.ts). */
	difficulty?: string;
}

export function graderPrompt(input: GradeInput): string {
	return [
		`PROBLEM SIZE: ${input.difficulty ?? "not stated"}`,
		"",
		"SKILLS TO GRADE (id: name):",
		...input.skills.map((s) => `- ${s.id}: ${s.name}`),
		"",
		"TRANSCRIPT:",
		input.transcript,
	].join("\n");
}

/** The grades for exactly the listed skills: strays dropped, a repeated skill's last entry wins, a skill the model
 *  skipped absent (the caller's default grade applies). */
export function gradesForSkills(verdict: GradeVerdict, skills: ReadonlyArray<{ id: string }>): Array<{ skill: string; grade: Grade }> {
	const listed = new Set(skills.map((s) => s.id));
	const last = new Map<string, Grade>();
	for (const g of verdict.grades ?? []) if (listed.has(g.skill)) last.set(g.skill, g.grade as Grade);
	return [...last].map(([skill, grade]) => ({ skill, grade }));
}

/** Grade one concluded problem. Throws when the grader never submits. */
export async function gradeProblem(input: GradeInput, deps: { engine: PiEngine | undefined; signal?: AbortSignal }): Promise<Array<{ skill: string; grade: Grade }>> {
	const verdict = await runSubmitAgent({
		role: "grader",
		toolName: "submit_grades",
		toolDescription: "Submit one grade (again, hard, good or easy) for every listed skill.",
		parameters: gradeSchema,
		fill: (v: GradeVerdict) => ({ grades: v.grades ?? [] }),
		systemPrompt: INSTRUCTIONS,
		prompt: graderPrompt(input),
		engine: deps.engine,
		signal: deps.signal,
		onStep: () => {},
		neverSubmitted: "the practice grader never submitted",
		maxTurns: 3,
	});
	return gradesForSkills(verdict, input.skills);
}
