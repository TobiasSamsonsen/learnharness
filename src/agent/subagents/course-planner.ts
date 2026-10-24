/**
 * The course planner (fork addition, 2026-10-24; spec: docs/courses.md
 * §3): reads a course's curriculum and DRAFTS its skill map — specific,
 * checkable skills with prerequisite edges, reusing skills already in the
 * graph and linking the propositions the learner already holds. The owner
 * reviews the draft; approval (src/server/courses.ts) writes it.
 *
 * A small agentic loop (runSubmitAgent): the material lookup tools, the
 * auditor's graph exploration (find / list_sessions / list_propositions),
 * list_skills, and ONE submit_draft call. The submit seam runs the same
 * validator approval runs (core/course-draft.ts), so an invalid draft is
 * retried here and never reaches the owner.
 */

import { Type, type Static } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CourseDraft, DraftSkill, Skill } from "../../core/contracts.ts";
import { draftProblems, uncitedMaterials, type DraftCheckContext } from "../../core/course-draft.ts";
import type { PiEngine } from "../models.ts";
import { serverExecute } from "../tool-execute.ts";
import { runSubmitAgent } from "./submit-agent.ts";

const INSTRUCTIONS = `You are the course planner of a learning application. A learner has given you a curriculum — everything a course expects them to be able to do — and you turn it into a SKILL MAP: the skills the learner must acquire, and which skills each one needs first. The app then tracks which skills the learner knows (by spaced practice problems) and always offers the next skills whose prerequisites are known.

WHAT A SKILL IS
- One specific, CHECKABLE ability: a practice problem can test it, and solving that problem cleanly shows the learner has it. "Differentiate a composition f(g(x)) with the chain rule" — not "Understand derivatives".
- name: a short handle, a few words ("Chain rule"). statement: the ability at full precision, starting with a verb.
- One ability per skill. Split a skill a single problem could not test; merge two that are always tested together.
- COVER the whole curriculum: every target it states (its "Scope and targets", its exercises) becomes one or more skills. Include the foundational skills the curriculum takes for granted only when a later skill genuinely builds on them.
- cite: where the curriculum asks for it, starting with the material's name ("Calculus notes, Ch. 3, p. 41"). Every material must be cited at least once.

PREREQUISITES (requires)
- "requires": the keys of skills that must be KNOWN before this one can be learned — genuine dependencies only, not the curriculum's chapter order. Keep the map a DAG: prerequisites point one way.
- The direct prerequisites are enough; never list what a prerequisite already requires.

REUSE — the learner's graph already holds skills (from other courses) and propositions (facts from past lessons)
- Call list_skills first. When a skill you need IS an existing skill — the same ability, however worded — set "reuse" to its id (keep its name and statement in your entry). A duplicate is better than a wrong merge: reuse only the same ability.
- restsOn: the ids of EXISTING propositions (find / list_sessions / list_propositions) that are genuinely the facts this skill uses. This connects the course to what the learner has already learned. Leave it empty when nothing in the graph fits — never guess an id.

THE MATERIAL
- The profiles below summarize each material. Check exact targets, definitions and exercises with material_search / material_read when the profile is not enough.
- Use the material's own terminology and notation in names and statements.

DELIVERABLE: ONE submit_draft call — a short summary (2–4 sentences: the shape of the map, what it reused) and the skills. Keys are "s1", "s2", …. A skill's "requires" names other keys.`;

const draftSkillSchema = Type.Object({
	key: Type.String({ minLength: 1, description: 'Draft-local key: "s1", "s2", …' }),
	reuse: Type.Optional(Type.String({ description: "An EXISTING skill id (from list_skills) this skill IS — omit for a new skill" })),
	name: Type.String({ minLength: 1, description: "A short handle — a few words" }),
	statement: Type.String({ minLength: 1, description: "The checkable ability at full precision, starting with a verb" }),
	requires: Type.Array(Type.String(), { description: "Keys of the skills that must be known first ([] for none)" }),
	restsOn: Type.Array(Type.String(), { description: "Ids of EXISTING propositions the skill uses ([] for none)" }),
	cite: Type.Optional(Type.String({ description: "Where the curriculum asks for it, starting with the material's name" })),
});

export const draftSchema = Type.Object({
	summary: Type.String({ minLength: 1, description: "2–4 sentences: the shape of the map, what it reused" }),
	skills: Type.Array(draftSkillSchema, { minItems: 1 }),
});

type DraftInput = Static<typeof draftSchema>;

function fillDraft(input: DraftInput): { summary: string; skills: DraftSkill[] } {
	return {
		summary: input.summary.trim(),
		skills: input.skills.map((s) => ({
			key: s.key.trim(),
			...(s.reuse && s.reuse.trim() ? { reuse: s.reuse.trim() } : {}),
			name: s.name.trim(),
			statement: s.statement.trim(),
			requires: [...new Set(s.requires.map((r) => r.trim()).filter(Boolean))],
			restsOn: [...new Set(s.restsOn.map((r) => r.trim()).filter(Boolean))],
			...(s.cite && s.cite.trim() ? { cite: s.cite.trim() } : {}),
		})),
	};
}

/** list_skills — every skill in the graph (glob over name + statement). */
function listSkillsTool(skills: () => readonly Skill[]): AgentTool<any> {
	const input = Type.Object({
		query: Type.Optional(Type.String({ description: "Optional glob over names and statements, e.g. *derivative*" })),
	});
	return {
		name: "list_skills",
		label: "list_skills",
		description:
			"List the skills already in the learner's graph (from other courses): id, name, statement, and the ids it requires. " +
			"Reuse one (set reuse to its id) when your skill is the same ability.",
		parameters: input,
		execute: serverExecute("list_skills", input, async ({ query }): Promise<string> => {
			const all = skills();
			const re = query ? new RegExp(`^${(query.includes("*") ? query : `*${query}*`).replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? "[\\s\\S]*" : `\\${c}`))}$`, "i") : null;
			const hits = re ? all.filter((s) => re.test(s.name) || re.test(s.statement)) : all;
			if (all.length === 0) return "The graph has no skills yet — every skill in your draft is new.";
			if (hits.length === 0) return `No skill matches "${query}".`;
			return `${hits.length} skill(s):\n${hits
				.map((s) => `- ${s.id} :: ${s.name}\n  statement: ${s.statement}${s.requires.length ? `\n  requires: ${s.requires.join(", ")}` : ""}`)
				.join("\n")}`;
		}),
	};
}

export interface CoursePlannerInput {
	title: string;
	/** Each material's name, id, and profile block (core/materials.ts). */
	materials: ReadonlyArray<{ id: string; name: string }>;
	materialsSection: string;
	/** The previous draft and the owner's change request (a re-draft). */
	previous?: { draft: CourseDraft; feedback: string };
	/** The approved skill set's names (a re-plan of an active course). */
	approved?: ReadonlyArray<{ id: string; name: string; statement: string }>;
}

export interface CoursePlannerDeps {
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	/** The draft checks' context, read fresh at every submit. */
	checkContext: () => DraftCheckContext;
	/** Material lookup + graph exploration tools. */
	tools: Record<string, AgentTool<any>>;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
	/** Debug recorder key. */
	courseId: string;
}

export function plannerPrompt(input: CoursePlannerInput): string {
	const parts = [`Course: ${input.title}`, "", input.materialsSection];
	if (input.approved && input.approved.length > 0) {
		parts.push(
			"",
			"The course's CURRENT approved skill map (the learner wants it re-planned — keep what still fits, by reusing these ids):",
			...input.approved.map((s) => `- ${s.id} :: ${s.name} — ${s.statement}`),
		);
	}
	if (input.previous) {
		parts.push(
			"",
			"Your PREVIOUS draft (not approved yet):",
			JSON.stringify({ summary: input.previous.draft.summary, skills: input.previous.draft.skills }, null, 1),
			"",
			`The learner asked for these changes: ${input.previous.feedback}`,
			"Submit a full revised draft that makes them.",
		);
	}
	return parts.join("\n");
}

/** Draft a course's skill map. Throws when the planner never submits. */
export async function draftCourse(input: CoursePlannerInput, deps: CoursePlannerDeps): Promise<{ summary: string; skills: DraftSkill[] }> {
	const skillsNow = () => [...deps.checkContext().skills.values()];
	return runSubmitAgent({
		role: "coursePlanner",
		chatId: deps.courseId,
		toolName: "submit_draft",
		toolDescription: "Submit the course's skill map draft: a short summary and every skill.",
		parameters: draftSchema,
		fill: fillDraft,
		systemPrompt: INSTRUCTIONS,
		prompt: plannerPrompt(input),
		engine: deps.engine,
		signal: deps.signal,
		onStep: deps.onStep,
		neverSubmitted: "the course planner never submitted a draft",
		extraTools: { ...deps.tools, list_skills: listSkillsTool(skillsNow) },
		maxTurns: 24,
		validate: (value) => {
			const problems = draftProblems(value.skills, deps.checkContext());
			const uncited = uncitedMaterials(value.skills, input.materials);
			if (uncited.length > 0) problems.push(`no skill cites ${uncited.map((n) => `"${n}"`).join(", ")} — every material must be cited at least once (cite starts with the material's name)`);
			return problems.length > 0 ? `Fix the draft and submit again:\n- ${problems.join("\n- ")}` : null;
		},
	});
}
