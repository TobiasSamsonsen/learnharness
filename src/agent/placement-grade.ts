/**
 * Placement grading seam (fork addition, 2026-11-24).
 *
 * Mirrors `agent/practice-grade.ts`: the server installs the real model-backed
 * grader (`server/placement-grade.ts`), and tests can leave it uninstalled or
 * install a stub. Runs on no-sketch placement answers in `chat-handler.ts`, and
 * on sketched placement answers right after `read_sketch` succeeds.
 */

import type { AfterToolCallContext, AfterToolCallResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { gradeFailureReason, type GradeNote } from "../core/grade-failure.ts";
import type { Grade } from "../core/mastery.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { formatPlacementStatus, placementProgressOf, type PlacementSkillInfo } from "../core/placement-frontier.ts";
import type { QuestionAnswerData } from "../core/question-core.ts";
import type { ResolvedModelSpec } from "./models.ts";
import type { PlacementGradeInput } from "./subagents/placement-grader.ts";

export interface PlacementGradeOutcome extends GradeNote {
	grade?: Grade;
}

export type PlacementGrader = (input: PlacementGradeInput, signal?: AbortSignal, session?: ResolvedModelSpec) => Promise<PlacementGradeOutcome>;

let installed: PlacementGrader | null = null;

export function installPlacementGrader(grader: PlacementGrader | null): void {
	installed = grader;
}

export function installedPlacementGrader(): PlacementGrader | null {
	return installed;
}

function fallbackGradeFor(toolName: "probe" | "recall", answer: QuestionAnswerData): Grade {
	if (answer.dontKnow) return "again";
	if (toolName === "probe") {
		if (answer.correct !== true) return "again";
		return (answer.confidence ?? 0) >= 70 ? "easy" : "hard";
	}
	return "hard";
}

function buildPlacementGradeInput(
	callBlock: { name: string; arguments?: unknown },
	answer: QuestionAnswerData,
	skill: { id: string; name: string; statement?: string },
	sketchReading?: { reading: string; uncertain?: string[] },
): PlacementGradeInput {
	const args = (callBlock.arguments ?? {}) as Record<string, unknown>;
	const options = Array.isArray(args.options)
		? args.options.map((o) => (o && typeof o === "object" ? String((o as { label?: unknown }).label ?? "") : String(o ?? ""))).filter(Boolean)
		: undefined;
	const selectedOption = Array.isArray(answer.answers) && answer.answers.length > 0
		? answer.answers.map((a) => a.label).join(", ")
		: undefined;
	const correctAnswer = typeof args.correctAnswer === "string" && args.correctAnswer.trim()
		? args.correctAnswer
		: typeof args.explanation === "string"
			? args.explanation
			: "";
	return {
		skill,
		toolName: callBlock.name === "recall" ? "recall" : "probe",
		question: String(args.question ?? answer.questionText ?? ""),
		...(options && options.length > 0 ? { options } : {}),
		correctAnswer,
		...(selectedOption ? { selectedOption } : {}),
		...(answer.correct !== undefined && !answer.dontKnow ? { correctPick: answer.correct } : {}),
		...(answer.dontKnow ? { dontKnow: true } : {}),
		...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
		...(answer.text ? { text: answer.text } : {}),
		...(answer.thinking ?? answer.note ? { thinking: answer.thinking ?? answer.note } : {}),
		...(sketchReading ? { sketchReading: sketchReading.reading, ...(sketchReading.uncertain?.length ? { sketchDoubts: sketchReading.uncertain } : {}) } : {}),
	};
}

/**
 * Grade one placement answer (used directly by `chat-handler.ts` for no-sketch
 * answers, and by `placementGradeAfterReadSketchHook` after `read_sketch`).
 */
export async function gradePlacementSubmission(opts: {
	callBlock: { name: string; arguments?: unknown };
	answer: QuestionAnswerData;
	skill: { id: string; name: string; statement?: string };
	sketchReading?: { reading: string; uncertain?: string[] };
	sessionModel?: ResolvedModelSpec;
	signal?: AbortSignal;
}): Promise<{ skill: string; grade: Grade; gradedBy?: string; gradeError?: string }> {
	const { callBlock, answer, skill, sketchReading, sessionModel, signal } = opts;
	const toolName: "probe" | "recall" = callBlock.name === "recall" ? "recall" : "probe";
	const hasWork = Boolean(sketchReading?.reading?.trim() || answer.text?.trim() || (answer.thinking ?? answer.note)?.trim());
	if (answer.dontKnow && !hasWork) {
		return { skill: skill.id, grade: "again" };
	}
	if (!installed) {
		return { skill: skill.id, grade: fallbackGradeFor(toolName, answer) };
	}
	try {
		const input = buildPlacementGradeInput(callBlock, answer, skill, sketchReading);
		const outcome = await installed(input, signal, sessionModel);
		if (outcome.grade) {
			return {
				skill: skill.id,
				grade: outcome.grade,
				...(outcome.gradedBy ? { gradedBy: outcome.gradedBy } : {}),
				...(outcome.gradeError ? { gradeError: outcome.gradeError } : {}),
			};
		}
		return {
			skill: skill.id,
			grade: fallbackGradeFor(toolName, answer),
			...(outcome.gradeError ? { gradeError: outcome.gradeError } : {}),
		};
	} catch (err) {
		if (signal?.aborted) throw err;
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[placement-grade] grader failed, fallback applies: ${message}`);
		return {
			skill: skill.id,
			grade: fallbackGradeFor(toolName, answer),
			gradeError: gradeFailureReason(message),
		};
	}
}

/**
 * `afterToolCall` hook for `createPlacementAgent`: when `read_sketch` succeeds
 * with no open doubts for the latest answered placement `probe`/`recall`, grade
 * that answer with the sketch reading and append the live frontier status.
 */
export function placementGradeAfterReadSketchHook(ctx: {
	placementSkills: readonly PlacementSkillInfo[];
	sessionModel?: ResolvedModelSpec;
}): (call: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined> {
	const byId = new Map(ctx.placementSkills.map((s) => [s.id, s]));
	return async ({ toolCall, assistantMessage, result, isError, context }, signal) => {
		if (toolCall.name !== "read_sketch" || isError) return undefined;
		const details = (result.details ?? {}) as { sketchId?: unknown; doubts?: unknown };
		if (typeof details.sketchId !== "string" || (typeof details.doubts === "number" && details.doubts > 0)) return undefined;

		const live = context.messages as unknown as LhMessage[];
		// Find the matching placement probe/recall answer that owns this sketchId
		let answerMsg: ToolResultMessage | undefined;
		for (let i = live.length - 1; i >= 0; i--) {
			const m = live[i] as { role?: string };
			if (m.role !== "toolResult") continue;
			const tr = m as ToolResultMessage;
			if (tr.isError || (tr.toolName !== "probe" && tr.toolName !== "recall")) continue;
			const ans = tr.details as QuestionAnswerData | undefined;
			if (ans?.sketch?.id === details.sketchId) {
				answerMsg = tr;
				break;
			}
		}
		if (!answerMsg) return undefined;

		let questionCall: { name: string; arguments?: unknown } | undefined;
		for (let i = live.length - 1; i >= 0; i--) {
			const m = live[i] as { role?: string };
			if (m.role !== "assistant") continue;
			const hit = (m as AssistantMessage).content.find((b) => b.type === "toolCall" && b.id === answerMsg!.toolCallId);
			if (hit && hit.type === "toolCall") {
				questionCall = hit;
				break;
			}
		}
		if (!questionCall) return undefined;

		const skillId = (questionCall.arguments as { skill?: unknown } | undefined)?.skill;
		if (typeof skillId !== "string") return undefined;
		const skill = byId.get(skillId) ?? { id: skillId, name: skillId };
		const args = (toolCall.arguments ?? {}) as { reading?: unknown; uncertain?: unknown };
		const placementGrade = await gradePlacementSubmission({
			callBlock: questionCall,
			answer: answerMsg.details as unknown as QuestionAnswerData,
			skill,
			sketchReading: {
				reading: String(args.reading ?? ""),
				uncertain: Array.isArray(args.uncertain) ? args.uncertain.map(String) : [],
			},
			sessionModel: ctx.sessionModel,
			signal,
		});

		// Compute updated frontier including this new placementGrade on a synthetic read_sketch result
		const syntheticReadResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: "read_sketch",
			content: result.content,
			details: { ...details, placementGrade } as unknown as ToolResultMessage["details"],
			isError: false,
			timestamp: Date.now(),
		};
		const holdsRead = live.some((m) => (m as { role?: string }).role === "toolResult" && (m as ToolResultMessage).toolCallId === toolCall.id);
		const messagesWithGrade = holdsRead ? live : [...live, assistantMessage as unknown as LhMessage, syntheticReadResult as unknown as LhMessage];
		const progress = placementProgressOf(messagesWithGrade, ctx.placementSkills);
		const statusLine = formatPlacementStatus(progress, ctx.placementSkills);
		const prevText = result.content.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
		return {
			content: [{ type: "text", text: `${prevText}\n\nGraded ${skillId}: ${placementGrade.grade}.\n${statusLine}` }],
			details: { ...details, placementGrade } as unknown as AfterToolCallResult["details"],
		};
	};
}
