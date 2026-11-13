/**
 * The practice grading seam (owner, 2026-11-09 — agent/subagents/grader.ts):
 * the practice agent's `afterToolCall` hook. When a `conclude` call in a
 * course session succeeds, it slices the problem out of the LIVE turn (the
 * stored record freezes at the turn's write-ahead, so it would miss the
 * newest sketch read-back), asks the installed grader for one grade per
 * tagged skill, and writes them into the conclude result's details. The fold
 * (core/mastery.ts) reads them from there.
 *
 * Like the answer-key check (question-verify.ts) the grader is installed by
 * the server; nothing installed — unit tests, the bare registry — leaves the
 * result untouched, so a record carries no grades and the outcome's default
 * applies. A grader failure never blocks the turn (owner, 2026-11-13): the installed grader
 * falls back to the session's own model and says so (`gradedBy`, `gradeError`); when nothing
 * graded, the list is empty, the reason rides beside it, and a solve falls to `hard` (core/mastery.ts).
 * The card shows both cases (components/practice-cards.tsx).
 */

import type { AfterToolCallContext, AfterToolCallResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { gradeFailureReason, type GradeNote } from "../core/grade-failure.ts";
import type { Grade } from "../core/mastery.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { problemSpanOf, renderProblemSpan, taggedSkillsOf } from "../core/practice-grading.ts";
import type { ResolvedModelSpec } from "./models.ts";
import type { GradeInput } from "./subagents/grader.ts";

/** One grading: the grades (empty when nothing graded) and what went wrong on the way. */
export interface GradeOutcome extends GradeNote {
	grades: Array<{ skill: string; grade: Grade }>;
}

/** `session` is the model the session runs on: the fallback when the grader's own model fails. */
export type PracticeGrader = (input: GradeInput, signal?: AbortSignal, session?: ResolvedModelSpec) => Promise<GradeOutcome>;

let installed: PracticeGrader | null = null;

export function installPracticeGrader(grader: PracticeGrader | null): void {
	installed = grader;
}

/** What the hook needs of the practice tool context. */
export interface PracticeGradeContext {
	courseSkills?: () => ReadonlyArray<{ id: string; name: string }>;
	difficulty?: string;
	/** The session's own model, the grader's fallback. Absent: no fallback. */
	sessionModel?: ResolvedModelSpec;
}

export function practiceGradeHook(ctx: PracticeGradeContext): (call: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined> {
	return async ({ toolCall, assistantMessage, isError, context }, signal) => {
		if (toolCall.name !== "conclude" || isError || !installed || !ctx.courseSkills) return undefined;
		// the live list may not hold this assistant message yet: add it so the conclude is in the span
		const live = context.messages as unknown as LhMessage[];
		const holdsConclude = live.some((m) => (m as { role?: string }).role === "assistant" && (m as AssistantMessage).content.some((b) => b.type === "toolCall" && b.id === toolCall.id));
		const span = problemSpanOf(holdsConclude ? live : [...live, assistantMessage as unknown as LhMessage], toolCall.id);
		const tagged = taggedSkillsOf(span);
		if (tagged.length === 0) return undefined;
		const names = new Map(ctx.courseSkills().map((s) => [s.id, s.name]));
		const skills = tagged.map((id) => ({ id, name: names.get(id) ?? id }));
		try {
			const outcome = await installed({ skills, transcript: renderProblemSpan(span, toolCall.id), ...(ctx.difficulty ? { difficulty: ctx.difficulty } : {}) }, signal, ctx.sessionModel);
			return { details: { grades: outcome.grades, ...(outcome.gradedBy ? { gradedBy: outcome.gradedBy } : {}), ...(outcome.gradeError ? { gradeError: outcome.gradeError } : {}) } };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// a stopped turn is not a grader failure: no reason is recorded
			if (signal?.aborted) return { details: { grades: [] } };
			console.warn(`[practice-grade] grader failed, a cautious default grade applies: ${message}`);
			return { details: { grades: [], gradeError: gradeFailureReason(message) } };
		}
	};
}
