/**
 * The lesson finish grading seam (owner, 2026-11-13 — core/final-problem.ts):
 * the teacher's `afterToolCall` hook in a course Learn session. When a
 * `finish_lesson` call succeeds, the installed practice grader (with its
 * fallback to the session's model) rates the final problem for the lesson's
 * skill, and the grade rides the finish result's details, where the fold
 * (core/mastery.ts) reads the skill's first rating.
 *
 * `again` turns the finish back: the result becomes an error telling the
 * teacher to repair the gap and pose a new final problem, so the transcript
 * holds no clean finish and the skill stays not learned. A grading that fails
 * altogether lets the finish stand with no grade (the fold counts it as hard)
 * and records the reason, like a concluded problem's. Nothing installed (unit
 * tests) leaves the result untouched.
 */

import type { AfterToolCallContext, AfterToolCallResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { FINISH_LESSON_TOOL } from "../core/course-session.ts";
import { FINISH_NOT_PASSED_TEXT, finalProblemSpanOf, renderFinalProblemSpan } from "../core/final-problem.ts";
import { gradeFailureReason } from "../core/grade-failure.ts";
import type { LhMessage } from "../core/native-messages.ts";
import type { ResolvedModelSpec } from "./models.ts";
import { installedPracticeGrader } from "./practice-grade.ts";

export interface LessonGradeContext {
	/** The lesson's one skill. */
	skill: { id: string; name: string };
	/** The session's own model, the grader's fallback. */
	sessionModel?: ResolvedModelSpec;
}

export function lessonGradeHook(ctx: LessonGradeContext): (call: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined> {
	return async ({ toolCall, assistantMessage, isError, context }, signal) => {
		const grader = installedPracticeGrader();
		if (toolCall.name !== FINISH_LESSON_TOOL || isError || !grader) return undefined;
		// the live list may not hold this assistant message yet: add it so the finish call is in the span
		const live = context.messages as unknown as LhMessage[];
		const holdsFinish = live.some((m) => (m as { role?: string }).role === "assistant" && (m as AssistantMessage).content.some((b) => b.type === "toolCall" && b.id === toolCall.id));
		const span = finalProblemSpanOf(holdsFinish ? live : [...live, assistantMessage as unknown as LhMessage], toolCall.id);
		// no final problem in the transcript (the finish gate let the call through after its refusal cap): nothing to grade
		if (span.length === 0) return undefined;
		try {
			const outcome = await grader({ skills: [ctx.skill], transcript: renderFinalProblemSpan(span, toolCall.id), difficulty: "final problem of a lesson" }, signal, ctx.sessionModel);
			const details = { grades: outcome.grades, ...(outcome.gradedBy ? { gradedBy: outcome.gradedBy } : {}), ...(outcome.gradeError ? { gradeError: outcome.gradeError } : {}) };
			const grade = outcome.grades.find((g) => g.skill === ctx.skill.id)?.grade;
			if (grade === "again") return { content: [{ type: "text", text: FINISH_NOT_PASSED_TEXT }], details, isError: true };
			return { details };
		} catch (err) {
			if (signal?.aborted) return { details: { grades: [] } };
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[lesson-grade] grader failed, the lesson finishes with a cautious default grade: ${message}`);
			return { details: { grades: [], gradeError: gradeFailureReason(message) } };
		}
	};
}
