/**
 * The course-session tools (fork addition, 2026-10-25; spec: docs/courses.md).
 *
 * - finish_lesson — the TEACHER's, in a course Learn session: logs the
 *   lesson finished, which makes its skill learned (core/mastery.ts). The
 *   learner's own path is the Finish lesson button (the lesson-finished
 *   marker); either one counts, the first one wins.
 * - probe (placement) — the PLACEMENT TESTER's one instrument: the
 *   prober's multiple-choice quiz plus a required `skill` — the one course
 *   skill the question tests. The learner's graded answer to it is the
 *   placement evidence. It keeps the `probe` name so the question dock
 *   renders it unchanged (QUESTION_TOOLS); its schema only adds the tag.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ChatStore } from "../../core/ports.ts";
import { FINISH_LESSON_TOOL, FINISH_SESSION_TOOL, sessionFinishOf } from "../../core/course-session.ts";
import { quizInputBase, quizInputProblems } from "../../core/question-core.ts";
import { invalidInputResult, questionResult, serverExecute } from "../tool-execute.ts";
import { verifyQuestion } from "../question-verify.ts";

const finishLessonInput = Type.Object({
	summary: Type.String({
		description: "One or two sentences: what the learner showed they can now do — the evidence the lesson is done.",
	}),
});

export function finishLessonTool(ctx: { chatId: string; chatStore: Pick<ChatStore, "getChat"> }): AgentTool<typeof finishLessonInput> {
	return {
		name: FINISH_LESSON_TOOL,
		label: FINISH_LESSON_TOOL,
		description:
			"Log this course lesson as FINISHED: its skill becomes learned, which unlocks the course skills that build on it. " +
			"Call it once — when the learner has shown they can do what the skill's statement says, or when they ask to finish. " +
			"After it, wrap up in a few sentences and pose no new question.",
		parameters: finishLessonInput,
		execute: serverExecute(FINISH_LESSON_TOOL, finishLessonInput, () => {
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (record && sessionFinishOf(record.messages)) return "The lesson was already finished — wrap up without a new question.";
			return "Logged: the lesson is finished and its skill now counts as learned. Wrap up in a few sentences — what they can now do, and what to practice — and pose no new question.";
		}),
	};
}

const finishSessionInput = Type.Object({
	summary: Type.String({
		description: "One or two sentences: what the session showed — the evidence its work is done.",
	}),
});

/** finish_session — every non-Learn course session's finish (owner,
 *  2026-10-25): the practice agent's (practice, review, context check) and
 *  the placement tester's. It marks the session done; the skills' boxes
 *  move only by the session's graded answers and concluded problems. */
export function finishSessionTool(ctx: { chatId: string; chatStore: Pick<ChatStore, "getChat"> }): AgentTool<typeof finishSessionInput> {
	return {
		name: FINISH_SESSION_TOOL,
		label: FINISH_SESSION_TOOL,
		description:
			"Log this course session as FINISHED — call it once, when the session's work is done (the course section says when) or when the " +
			"learner asks to stop. It marks the session done in the course; it changes no skill. Never call it while a question or problem is open. " +
			"After it, write your closing words and pose nothing more.",
		parameters: finishSessionInput,
		execute: serverExecute(FINISH_SESSION_TOOL, finishSessionInput, () => {
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (record && sessionFinishOf(record.messages)) return "The session was already finished — close without a new question or problem.";
			return "Logged: the session is finished. Close in a few sentences — what it showed — and pose nothing more.";
		}),
	};
}

/** The placement probe's schema: the shared quiz authoring fields plus the
 *  skill tag, which LEADS (fields generated first get dropped least — the
 *  2026-10-09 drop-order ruling). */
export const placementProbeInput = Type.Object({
	skill: Type.String({
		description: "REQUIRED — the id of the ONE course skill this question tests, copied exactly from the session context's skill list.",
	}),
	...quizInputBase.properties,
});

export function placementProbeTool(skills: () => ReadonlyArray<{ id: string; name: string }>): AgentTool<typeof placementProbeInput> {
	return {
		name: "probe",
		label: "probe",
		description:
			"Ask the learner ONE graded multiple-choice placement question that tests ONE course skill (`skill`). The learner " +
			"picks an option (or 'I don't know') and states a confidence; their answer, graded against correctAnswer, is the " +
			"course's placement evidence. Options-only; give each option a stable `value` and reference the correct one by it. " +
			"ONE question per turn: call it, then end your turn.",
		parameters: placementProbeInput,
		executionMode: "sequential",
		execute: async (_toolCallId, input, signal) => {
			const problems = [...quizInputProblems(input)];
			const list = skills();
			if (!list.some((s) => s.id === input.skill)) {
				problems.push(`skill "${input.skill}" is not one of this course's skill ids — copy one exactly: ${list.map((s) => s.id).join(", ")}`);
			}
			if (problems.length > 0) return invalidInputResult("probe", problems);
			const wrong = await verifyQuestion(input, signal);
			if (wrong.length > 0) return invalidInputResult("probe", wrong);
			return questionResult();
		},
	};
}
