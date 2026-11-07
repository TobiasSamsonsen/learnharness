/**
 * THE PRACTICE TOOLS (practice sessions, owner design 2026-10-04): the
 * practice agent's ENTIRE toolset — `problem` (pose: terminates the turn;
 * the commitment rides the call's arguments, hidden from the learner UI)
 * and `conclude` (end the problem: normal result, the turn continues so
 * the same reply can reveal + pose the next). The gating law (owner
 * ruling): an agent cannot pose while a problem is active and cannot
 * conclude with nothing active — activeProblemOf is the single fold both
 * gates read.
 *
 * Mechanics-only descriptions (the doctrine ruling, 2026-10-04): the tool
 * descriptions carry WHAT to pass and WHAT happens — the theory, the
 * commit-before-pose law, the hint ladder all live in the system prompt
 * (prompts/practice/10-doctrine.md).
 */

import { Type, type Static } from "typebox";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { resolveTargetId } from "../../core/chains.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { jobTools, type JobToolContext } from "./jobs.ts";
import { proberGraphTools, type GraphToolContext } from "./graph.ts";
import { activeProblemOf } from "../../core/native-messages.ts";
import { figureInputProblems } from "../../core/figures/index.ts";
import { circuitSolveTool, figureGuideTool } from "./figures.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { concludeResult, invalidInputResult, problemResult } from "../tool-execute.ts";
import { healEncodedArguments, healToolRecord } from "./heal.ts";
import { readSketchTool } from "./sketch.ts";
import { noteSketchRead, sketchConcludeProblems, sketchGateOf, sketchIdsOf, type SketchGate } from "../../core/sketch-gate.ts";
import { difficultyInfo, maxSkillsFor, type Difficulty } from "../../core/difficulty.ts";


/** The record-reading context the gates need (the plan-tools idiom). */
export interface PracticeToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[]; kind?: string } | null };
	/** The WHOLE-graph node list, read fresh per pose (owner round 9 — the
	 *  mastery-trace contract): targets validate against every proposition,
	 *  not just the session's picks, so pickless sessions and future
	 *  graph-tools poses stay valid. Absent (tests) = no validation. */
	graphNodes?: () => ReadonlyArray<Pick<import("../../core/contracts/graph.ts").GraphNode, "id" | "name">>;
	/** THE RARELY-NEEDED SET (owner round 10, 2026-10-05): the map readers
	 *  behind the SAME settings gate as the prober's (graphToolsEnabled at
	 *  the composition root); the research + pdf jobs (both keyless).
	 *  Each absent context (tests) = absent from the registry. */
	graph?: GraphToolContext;
	jobs?: JobToolContext;
	/** COURSE SESSIONS (fork addition — docs/courses.md §1.4): the
	 *  session's skills. Present → the problem tool carries a `skills`
	 *  field, validated against exactly these (names normalize to ids).
	 *  Absent → the field does not exist. */
	courseSkills?: () => ReadonlyArray<{ id: string; name: string }>;
	/** The session's problem difficulty (fork addition, 2026-11-07 — core/difficulty.ts), resolved per turn.
	 *  Present → the problem tool rejects more skill tags than the level allows (course sessions, where
	 *  skills exist). Absent → no cap. */
	difficulty?: Difficulty;
}

/** TURN-SCOPED GATE STATE (the BKT incident, 2026-10-05): the gates used
 *  to read the STORED record — but the record freezes at the turn's
 *  write-ahead (persistTurn lands only at turn END), so a mid-turn
 *  conclude → pose pair could never see each other: every conclude
 *  succeeded against the stale record and every following pose died on
 *  "a problem is already active" until the model gave up ("the problem
 *  slot is stuck"). The gate seeds ONCE from the record at construction
 *  (one practiceTools per turn — chat-handler builds the agent per
 *  request, so there is no cross-turn leakage), and the executes flip
 *  this closure — the intra-turn truth the record cannot hold yet. */
export interface PracticeGate {
	problemActive: boolean;
	/** The active problem's tagged skill ids (a course session); conclude
	 *  must grade exactly these. Absent/empty = nothing to grade. */
	skills?: string[];
	/** The active problem's newest sketch and its reading state (Android
	 *  plan M2): conclude as solved waits on it. Null/absent = nothing to
	 *  gate. */
	sketch?: SketchGate | null;
}

/** Seed the turn's gate from the record (result-aware activeProblemOf —
 *  only a cleanly-posed problem counts). */
export function createPracticeGate(ctx: PracticeToolContext): PracticeGate {
	const record = ctx.chatStore.getChat(ctx.chatId);
	const active = record ? activeProblemOf(record.messages) : null;
	const tagged = (active?.input as { skills?: unknown } | undefined)?.skills;
	// ids, whatever the record kept: a name the pose was normalized from still
	// resolves, so a conclude can never be refused for grading "the wrong" skill
	const list = ctx.courseSkills?.() ?? [];
	return {
		problemActive: active !== null,
		skills: Array.isArray(tagged) ? [...new Set(tagged.filter((s): s is string => typeof s === "string").map((s) => resolveSkillId(s, list) ?? s))] : [],
		sketch: record ? sketchGateOf(record.messages as unknown as AgentMessage[], active?.toolCallId ?? null) : null,
	};
}

// ─── problem: the pose ───────────────────────────────────────────────────────

export const problemInputObject = Type.Object({
	statement: Type.String({
		description:
			"REQUIRED — the problem as the learner sees it (markdown + LaTeX). Must be self-contained and " +
			"solvable from the session's material. NEVER announces the target proposition.",
	}),
	mode: Type.Union([Type.Literal("recall"), Type.Literal("discrimination"), Type.Literal("composition")], {
		description: "REQUIRED — the demand mode: recall, discrimination, or composition (bare words, no quotes).",
	}),
	target: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 1,
			description:
				"The proposition id(s) this problem exercises, from the session context's [id] list — include when " +
				"the material is in the map; OMIT entirely when it is not (a topic session poses untagged problems). " +
				"Names are normalized to ids at the seam; an unknown proposition is rejected.",
		}),
	),
	modelSolution: Type.String({
		description: "REQUIRED — the full solution, moves in order, committed BEFORE the learner sees the problem. This IS the reveal — conclude shows it verbatim; never re-author it.",
	}),
});

export type ProblemInput = Static<typeof problemInputObject>;

/** The course-session pose (docs/courses.md §1.4): the same problem plus
 *  the skills it tests — the evidence the course's boxes fold over. */
export const courseProblemInputObject = Type.Object({
	...problemInputObject.properties,
	skills: Type.Array(Type.String(), {
		minItems: 1,
		description:
			"REQUIRED in a course session — the skill id(s) this problem tests, from the session context's skill list. " +
			"Only the skills solving it genuinely requires; the outcome you conclude with moves exactly these skills' review boxes.",
	}),
});

/** A skill reference → its id: an exact id, else a case-insensitive name. */
function resolveSkillId(ref: string, skills: ReadonlyArray<{ id: string; name: string }>): string | null {
	const trimmed = ref.trim();
	if (skills.some((s) => s.id === trimmed)) return trimmed;
	const byName = skills.filter((s) => s.name.toLowerCase() === trimmed.toLowerCase());
	return byName.length === 1 ? byName[0]!.id : null;
}

export function problemTool(
	gate: PracticeGate,
	graphNodes?: PracticeToolContext["graphNodes"],
	courseSkills?: PracticeToolContext["courseSkills"],
	difficulty?: PracticeToolContext["difficulty"],
): AgentTool<typeof problemInputObject> {
	const parameters = courseSkills ? courseProblemInputObject : problemInputObject;
	return {
		name: "problem",
		label: "problem",
		description:
			"Pose one practice problem. Ends the turn — the learner works in the thinking field; their thinking " +
			"traces and answer commits arrive back as labeled messages. The modelSolution rides this call's " +
			"arguments and stays hidden from the learner until you conclude (conclude shows it verbatim — the " +
			"reveal needs no new field). Only one problem may be active — conclude it before posing the next.",
		parameters: parameters as typeof problemInputObject,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => {
			const healed = withSkillIds(healEncodedArguments(args, parameters), courseSkills);
			// TARGET NORMALIZATION (owner round 9): names silently become ids —
			// the RECORD carries canonical ids (the mastery trace groups on
			// them); unresolvable strings pass through for execute to reject.
			// UNTAGGED PROBLEMS (owner round 12): an explicit empty list is
			// the model saying "no targets" — healed AWAY, so the record's
			// canonical form is tagged-or-absent, never [].
			if (!graphNodes) {
				const bare = (healed as { target?: unknown }).target;
				return Array.isArray(bare) && bare.length === 0
					? ({ ...(healed as Record<string, unknown>), target: undefined } as never)
					: (healed as never);
			}
			const target = (healed as { target?: unknown }).target;
			if (!Array.isArray(target) || target.length === 0) {
				return { ...(healed as Record<string, unknown>), target: undefined } as never;
			}
			const list = graphNodes();
			const normalized = target.map((t) =>
				typeof t === "string" ? (resolveTargetId(t, list) ?? t) : t,
			);
			if (normalized.every((t, i) => t === target[i])) return healed as never;
			return { ...(healed as Record<string, unknown>), target: normalized } as never;
		},
		execute: async (_toolCallId, input) => {
			if (gate.problemActive) {
				return invalidInputResult("problem", [
					"a problem is already active — call conclude on it before posing the next one",
				]);
			}
			// SKILL VALIDATION (course sessions): every tag must be one of
			// the session's skills — the boxes fold over exactly these.
			if (courseSkills) {
				const tags = (input as { skills?: unknown }).skills;
				const list = courseSkills();
				const unknown = Array.isArray(tags) ? tags.filter((t) => typeof t !== "string" || resolveSkillId(t, list) === null) : [];
				if (!Array.isArray(tags) || tags.length === 0) {
					return invalidInputResult("problem", ["skills is required in a course session — tag the skill id(s) this problem tests"]);
				}
				if (unknown.length > 0) {
					return invalidInputResult("problem", [
						`skills ${JSON.stringify(unknown)} are not this session's skills — use ids from the session context's skill list: ${list.map((s) => s.id).join(", ")}`,
					]);
				}
				// DIFFICULTY (fork addition, 2026-11-07): the level caps how many skills one problem tests.
				if (difficulty && Array.isArray(tags) && tags.length > maxSkillsFor(difficulty)) {
					return invalidInputResult("problem", [
						`this session's difficulty is ${difficultyInfo(difficulty).label}: tag at most ${maxSkillsFor(difficulty)} skill(s) per problem (you tagged ${tags.length}) — pose a smaller problem that tests fewer skills, or tag only the skills it genuinely requires`,
					]);
				}
			}
			// TARGET VALIDATION (owner round 9, round 12): against the WHOLE
			// graph, and ONLY when targets are present — absent means an
			// untagged problem (topic sessions, owner round 12), which poses
			// freely. A one-line rejection — the proposition list already
			// sits in the agent's context (the [id] marker); no re-listing.
			// The message teaches the exit: omitting always works.
			if (graphNodes && input.target && input.target.length > 0) {
				const list = graphNodes();
				const unknown = input.target.filter((t) => resolveTargetId(t, list) === null);
				if (unknown.length > 0) {
					return invalidInputResult("problem", [
						`target ${JSON.stringify(unknown)} is not a known proposition — targets must be proposition ids from the session context; if the material is not in the map, omit target entirely`,
					]);
				}
			}
			// FIGURES (owner, 2026-10-26): every ```plot / ```blocks in the
			// statement or solution parses before the learner sees it — each
			// field on its own (they render as separate cards).
			const figures = figureInputProblems(input, { perField: true });
			if (figures.length > 0) return invalidInputResult("problem", figures);
			gate.problemActive = true;
			const posed = (input as { skills?: unknown }).skills;
			gate.skills = Array.isArray(posed) ? posed.filter((s): s is string => typeof s === "string") : [];
			gate.sketch = null; // a fresh problem starts with no sketch
			return problemResult();
		},
	};
}

/** Normalize skill names to ids at the seam (the target-normalization
 *  idiom): the RECORD carries canonical ids — the box fold groups on
 *  them. Unresolvable entries pass through for execute to reject. */
function withSkillIds(healed: unknown, courseSkills: PracticeToolContext["courseSkills"]): unknown {
	if (!courseSkills) return healed;
	const skills = (healed as { skills?: unknown }).skills;
	if (!Array.isArray(skills)) return healed;
	const list = courseSkills();
	const normalized = [...new Set(skills.map((s) => (typeof s === "string" ? (resolveSkillId(s, list) ?? s) : s)))];
	return { ...(healed as Record<string, unknown>), skills: normalized };
}

// ─── conclude: the end of a problem ──────────────────────────────────────────

/** `grades[].skill` references (ids or names) → ids, as `skills` does at the
 *  pose. Unresolvable entries pass through for execute to reject. */
function withGradeSkillIds(healed: unknown, courseSkills: PracticeToolContext["courseSkills"]): unknown {
	if (!courseSkills) return healed;
	const grades = (healed as { grades?: unknown }).grades;
	if (!Array.isArray(grades)) return healed;
	const list = courseSkills();
	const normalized = grades.map((g) => {
		const skill = (g as { skill?: unknown } | null)?.skill;
		return typeof skill === "string" && g && typeof g === "object" ? { ...(g as object), skill: resolveSkillId(skill, list) ?? skill } : g;
	});
	return { ...(healed as Record<string, unknown>), grades: normalized };
}

export const concludeInputObject = Type.Object({
	outcome: Type.Union(
		[
			Type.Literal("solved"),
			Type.Literal("solvedWithHints"),
			Type.Literal("movedOn"),
			Type.Literal("surrendered"),
			Type.Literal("taught"),
			Type.Literal("dismissed"),
		],
		{
			description:
				"REQUIRED — the outcome: solved, solvedWithHints, movedOn, surrendered, or taught — bare words, no quotes " +
				"(dismissed is synthesized, never yours). taught = you showed the correction and taught the point yourself " +
				"instead of the learner reaching it.",
		},
	),
	verdict: Type.String({
		description: "REQUIRED — the plain-language verdict: what was credited, where it broke. On a wrong answer: localize the break, do NOT give the correction.",
	}),
	rung: Type.Union(
		[Type.Literal("R0"), Type.Literal("R1"), Type.Literal("R2"), Type.Literal("R3"), Type.Literal("R4"), Type.Literal("R5"), Type.Null()],
		{ description: "REQUIRED — the hint-ladder rung the problem needed: R0 through R5, or null = no hint was given (bare, no quotes)." },
	),
	missClass: Type.Union(
		[
			Type.Literal("cue"),
			Type.Literal("discrimination"),
			Type.Literal("execution"),
			Type.Literal("careless"),
			Type.Literal("structural"),
			Type.Null(),
		],
		{ description: "REQUIRED — the miss classification: cue, discrimination, execution, careless, or structural — or null = no miss (bare, no quotes)." },
	),
	retest: Type.Boolean({ description: "REQUIRED — true marks the problem for a fresh-surface retest before the session ends." }),
	grades: Type.Optional(
		Type.Array(
			Type.Object({
				skill: Type.String({ description: "A skill id the problem was tagged with." }),
				grade: Type.Union([Type.Literal("again"), Type.Literal("hard"), Type.Literal("good"), Type.Literal("easy")], {
					description: "again, hard, good or easy — bare word, no quotes.",
				}),
			}),
			{
				description:
					"REQUIRED in a course session — one entry per tagged skill: your judgment of what the learner demonstrated on THAT skill " +
					"(Anki scale: again < hard < good < easy), never more than they demonstrated. This is what the course's understanding " +
					"rating folds over; the practice prompt's grading guideline says how to judge. Omit outside a course session.",
			},
		),
	),
});

export type ConcludeInput = Static<typeof concludeInputObject>;

export function concludeTool(gate: PracticeGate, courseSkills?: PracticeToolContext["courseSkills"]): AgentTool<typeof concludeInputObject> {
	return {
		name: "conclude",
		label: "conclude",
		description:
			"Conclude the active problem: records the outcome + verdict, reveals the committed solution, and frees " +
			"the learner's composer. After the result, say your closing words about the learner's work if useful, then " +
			"END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's " +
			"explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, " +
			"answer their questions about the concluded one. Nothing may conclude unless a problem is active.",
		parameters: concludeInputObject,
		prepareArguments: (args: unknown) => withGradeSkillIds(healEncodedArguments(args, concludeInputObject), courseSkills) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			if (!gate.problemActive) {
				return invalidInputResult("conclude", ["no active problem to conclude — pose one first"]);
			}
			// GRADES (course sessions): exactly the problem's tagged skills, each once
			const tagged = gate.skills ?? [];
			if (tagged.length > 0) {
				const graded = (input.grades ?? []).map((g) => g.skill);
				const problems: string[] = [];
				if (graded.length === 0) problems.push(`grades is required in a course session — one { skill, grade } entry for each tagged skill: ${tagged.join(", ")}`);
				else {
					const stray = graded.filter((id) => !tagged.includes(id));
					const missing = tagged.filter((id) => !graded.includes(id));
					if (stray.length > 0) problems.push(`grades names ${JSON.stringify(stray)}, which this problem did not tag — grade only: ${tagged.join(", ")}`);
					if (missing.length > 0) problems.push(`grades is missing ${JSON.stringify(missing)} — grade every tagged skill: ${tagged.join(", ")}`);
				}
				if (problems.length > 0) return invalidInputResult("conclude", problems);
			}
			// THE SKETCH GATE (Android plan M2): a solved outcome waits on the
			// newest sketch being read, free of doubts, and undisputed. A refusal
			// is an error result — never mastery evidence.
			const waiting = sketchConcludeProblems(gate.sketch ?? null, input.outcome);
			if (waiting.length > 0) return invalidInputResult("conclude", waiting);
			gate.problemActive = false;
			return concludeResult();
		},
	};
}

/** The practice toolset (the practice agent's whole registry). */
export function practiceTools(ctx: PracticeToolContext): Record<string, AgentTool<any>> {
	// ONE gate per turn, shared by both tools — the intra-turn truth.
	const gate = createPracticeGate(ctx);
	// THE RARELY-NEEDED SET (owner round 10): read/ls/find/grep over the
	// learner's files (always — the same read-only set the teacher and
	// prober carry), the research + pdf jobs (available without search
	// keys; demo/visual stay teach-only), and
	// the prober's map readers when the settings gate opened. None are
	// toggle-filtered: problem/conclude are the session; these are
	// exceptions the doctrine says to reach for rarely.
	const jobs = ctx.jobs ? jobTools(ctx.jobs) : null;
	// healToolRecord (owner, 2026-10-09 — the whitehead generalization):
	// the standard argument heal over the WHOLE registry. problem/conclude
	// keep their own (target-normalizing) prepareArguments as the composed
	// inner pass; the double heal is idempotent by construction.
	return healToolRecord({
		problem: problemTool(gate, ctx.graphNodes, ctx.courseSkills, ctx.difficulty),
		conclude: concludeTool(gate, ctx.courseSkills),
		// The tutor's transcription of the learner's handwriting (Android
		// plan M2) — sketches are named from the record, fresh per call; a
		// read flips the conclude gate mid-turn.
		read_sketch: readSketchTool({
			known: () => sketchIdsOf((ctx.chatStore.getChat(ctx.chatId)?.messages ?? []) as unknown as AgentMessage[]),
			onRead: (sketchId, uncertain) => noteSketchRead(gate.sketch ?? null, sketchId, uncertain),
		}),
		figure_guide: figureGuideTool,
		circuit_solve: circuitSolveTool,
		read: readTool,
		ls: lsTool,
		find: findTool,
		grep: grepTool,
		...(jobs?.research ? { research: jobs.research } : {}),
		...(jobs ? { pdf: jobs.pdf! } : {}),
		...(ctx.graph ? proberGraphTools(ctx.graph) : {}),
	});
}
