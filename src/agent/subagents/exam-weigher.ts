/**
 * The exam weigher (owner, 2026-11-13; spec: docs/courses.md §2): one model pass over a course's sources and its
 * approved skill list that says how much the course's EXAMS use each skill (0-3, core/exam-plan.ts). The learner
 * presses "Weigh by exams" on the course page; the weights order Next up and feed the pace forecast.
 *
 * A small agentic loop (runSubmitAgent): the material lookup tools and ONE submit_weights call. The submit
 * validation refuses a missing, repeated or unknown skill, so an incomplete answer is retried here.
 */

import { Type, type Static } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { parseWeightValue, type SkillWeightValue } from "../../core/exam-plan.ts";
import { withLanguageDirective, type LessonLanguage } from "../../core/language.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

const INSTRUCTIONS = `You weigh how much a course's EXAMS use each of its skills. You get the course's sources and its skill list. Find the sources that show what is examined: past exams and solutions first, then exercise sets marked as exam preparation, then the syllabus. Read them with the lookup tools (material_search, material_read); do not rely on the profiles alone.

Give every skill one weight:
 3  in nearly every exam, or worth many points
 2  in several exams
 1  examined sometimes, or only inside other problems; also your answer when the sources show no exams at all
 0  in the syllabus but never examined, or explicitly excluded
A skill a heavy problem cannot be solved without counts with that problem. Give a one-line reason naming the evidence ("Exam 2025 task 3, 2024 task 2"). Say plainly in the summary when you found no past exams.

DELIVERABLE: ONE submit_weights call: a short summary (2-3 sentences: which sources you used, how many past exams you found) and one entry for EVERY listed skill, by its id.`;

const weightsSchema = Type.Object({
	summary: Type.String({ minLength: 1, description: "2-3 sentences: the sources used, how many past exams were found" }),
	weights: Type.Array(
		Type.Object({
			skill: Type.String({ minLength: 1, description: "A skill id from the list" }),
			weight: Type.Integer({ minimum: 0, maximum: 3, description: "0 not examined, 1 sometimes, 2 often, 3 nearly every exam" }),
			reason: Type.String({ description: "One line naming the evidence" }),
		}),
		{ minItems: 1, description: "One entry for every listed skill" },
	),
});

type WeightsInput = Static<typeof weightsSchema>;

export interface WeighedCourse {
	summary: string;
	weights: Array<{ skill: string; weight: SkillWeightValue; reason: string }>;
}

function fillWeights(input: WeightsInput): WeighedCourse {
	return {
		summary: input.summary.trim(),
		weights: input.weights.flatMap((w) => {
			const weight = parseWeightValue(w.weight);
			return weight === null ? [] : [{ skill: w.skill.trim(), weight, reason: w.reason.trim() }];
		}),
	};
}

/** The submit check: every listed skill exactly once, nothing else. Null = fine. */
export function weightsProblems(value: WeighedCourse, skillIds: readonly string[]): string[] {
	const listed = new Set(skillIds);
	const seen = new Set<string>();
	const problems: string[] = [];
	for (const w of value.weights) {
		if (!listed.has(w.skill)) problems.push(`"${w.skill}" is not a listed skill id`);
		else if (seen.has(w.skill)) problems.push(`"${w.skill}" has more than one entry`);
		seen.add(w.skill);
	}
	const missing = skillIds.filter((id) => !seen.has(id));
	if (missing.length > 0) problems.push(`no entry for ${missing.map((id) => `"${id}"`).join(", ")}`);
	return problems;
}

export interface ExamWeigherInput {
	title: string;
	/** The material profiles block (core/materials.ts materialBlock, wrapped as in the planner). */
	materialsSection: string;
	skills: ReadonlyArray<{ id: string; name: string; statement: string }>;
	language: LessonLanguage;
}

export interface ExamWeigherDeps {
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	/** The material lookup tools, keyed to the course. */
	tools: Record<string, AgentTool<any>>;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
	/** Debug recorder key. */
	courseId: string;
}

export function weigherPrompt(input: ExamWeigherInput): string {
	return [
		`Course: ${input.title}`,
		"",
		input.materialsSection,
		"",
		"The course's skills (id :: name — statement):",
		...input.skills.map((s) => `- ${s.id} :: ${s.name} — ${s.statement}`),
	].join("\n");
}

/** Weigh a course's skills by its exams. Throws when the pass never submits a complete answer. */
export async function weighCourse(input: ExamWeigherInput, deps: ExamWeigherDeps): Promise<WeighedCourse> {
	const ids = input.skills.map((s) => s.id);
	return runSubmitAgent({
		role: "coursePlanner",
		chatId: deps.courseId,
		toolName: "submit_weights",
		toolDescription: "Submit the exam weight (0-3) of every listed skill, with a one-line reason each.",
		parameters: weightsSchema,
		fill: fillWeights,
		systemPrompt: withLanguageDirective(INSTRUCTIONS, input.language, "course"),
		prompt: weigherPrompt(input),
		engine: deps.engine,
		signal: deps.signal,
		onStep: deps.onStep,
		neverSubmitted: "the exam weigher never submitted its weights",
		// a weak model may send the whole array as one JSON string
		prepareArguments: (args) => {
			if (typeof args !== "object" || args === null) return args;
			const raw = args as { weights?: unknown };
			if (typeof raw.weights !== "string") return args;
			try {
				const parsed: unknown = JSON.parse(raw.weights);
				return Array.isArray(parsed) ? { ...raw, weights: parsed } : args;
			} catch {
				return args;
			}
		},
		extraTools: deps.tools,
		maxTurns: 20,
		validate: (value) => {
			const problems = weightsProblems(value, ids);
			return problems.length > 0 ? `Fix the weights and submit again:\n- ${problems.join("\n- ")}` : null;
		},
	});
}
