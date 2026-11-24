/**
 * Placement grader (fork addition, 2026-11-24): grades ONE placement answer
 * (MC `probe` or open-ended `recall`) for ONE skill using the question,
 * committed answer/options, learner's response, sketch read-back, and stated
 * confidence as context.
 */

import { Type, type Static } from "typebox";
import { GRADES, type Grade } from "../../core/mastery.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

const PLACEMENT_GRADER_INSTRUCTIONS = `You grade how well a learner knows ONE skill from a single placement-test question, after they answered (and after any handwritten sketch was transcribed).

Grade on the four-point scale: again < hard < good < easy.

- EASY: Clearly knows the skill. Correct answer with sound reasoning/work (if shown), or clean confident hit on a conceptual question. Credits the skill as known AND credits its prerequisite chain.
- GOOD: Understands the core method and gets the right idea, or gets it right with a tiny mechanical slip or noticeably low confidence (e.g. 10–50%). Means they hold the fundamentals/prerequisites and only need some practice, not a full lesson. Credits the skill as learned and credits its prerequisites.
- HARD: Partial or shaky grasp — e.g., right setup/concept on the sketch with a real execution/algebra error, or hesitant/weak justification. Deserves practice, NOT strong enough to credit prerequisites.
- AGAIN: Wrong model, blank / "I don't know" with no sound setup on the sketch, or fundamental misconception. Blocks inferred prerequisite credit.

Use stated confidence as context (a right answer at low confidence leans \`good\`, or \`hard\` if reasoning is shaky), never as a mechanical cutoff. Submit exactly one grade.`;

export const placementGradeSchema = Type.Object({
	grade: Type.Union(
		GRADES.map((g) => Type.Literal(g)),
		{ description: "again, hard, good or easy — bare word, no quotes." },
	),
});

export type PlacementGradeVerdict = Static<typeof placementGradeSchema>;

export interface PlacementGradeInput {
	skill: { id: string; name: string; statement?: string };
	toolName: "probe" | "recall";
	question: string;
	options?: readonly string[];
	correctAnswer: string;
	selectedOption?: string;
	correctPick?: boolean;
	dontKnow?: boolean;
	confidence?: number;
	text?: string;
	thinking?: string;
	sketchReading?: string;
	sketchDoubts?: readonly string[];
}

export function placementGraderPrompt(input: PlacementGradeInput): string {
	const lines: string[] = [
		`SKILL: ${input.skill.id} — ${input.skill.name}${input.skill.statement ? `: ${input.skill.statement}` : ""}`,
		`FORMAT: ${input.toolName === "probe" ? "multiple-choice (probe)" : "open-ended (recall)"}`,
		"",
		`QUESTION: ${input.question}`,
	];
	if (input.options && input.options.length > 0) {
		lines.push(`OPTIONS: ${input.options.map((o, i) => `${i + 1}) ${o}`).join(" | ")}`);
	}
	lines.push(`COMMITTED SOLUTION: ${input.correctAnswer}`, "", "LEARNER RESPONSE:");
	if (input.dontKnow) lines.push("- Chose: I don't know");
	if (input.selectedOption) {
		lines.push(`- Selected option: ${input.selectedOption}${input.correctPick !== undefined ? ` (key match: ${input.correctPick ? "yes" : "no"})` : ""}`);
	}
	if (input.confidence !== undefined) lines.push(`- Stated confidence: ${input.confidence}%`);
	if (input.text) lines.push(`- Written/typed answer: ${input.text}`);
	if (input.thinking) lines.push(`- Thinking/notes: ${input.thinking}`);
	if (input.sketchReading) {
		const doubts = input.sketchDoubts && input.sketchDoubts.length > 0 ? ` (uncertain: ${input.sketchDoubts.join("; ")})` : "";
		lines.push(`- Handwritten sketch read-back${doubts}: ${input.sketchReading}`);
	}
	return lines.join("\n");
}

export async function gradePlacementAnswer(input: PlacementGradeInput, deps: { engine: PiEngine | undefined; signal?: AbortSignal }): Promise<Grade> {
	const verdict = await runSubmitAgent({
		role: "grader",
		toolName: "submit_placement_grade",
		toolDescription: "Submit one grade (again, hard, good, or easy) for this placement answer.",
		parameters: placementGradeSchema,
		fill: (v: PlacementGradeVerdict) => ({ grade: v.grade }),
		systemPrompt: PLACEMENT_GRADER_INSTRUCTIONS,
		prompt: placementGraderPrompt(input),
		engine: deps.engine,
		signal: deps.signal,
		onStep: () => {},
		neverSubmitted: "the placement grader never submitted",
		maxTurns: 3,
	});
	return verdict.grade as Grade;
}
