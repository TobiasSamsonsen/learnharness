import { resolveConversationSpec, resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec, type ResolvedModelSpec } from "../agent/models.ts";
import type { GradeOutcome } from "../agent/practice-grade.ts";
import { gradeProblem, type GradeInput } from "../agent/subagents/grader.ts";
import { emit } from "../core";
import { resolveDifficulty } from "../core/difficulty.ts";
import { gradeFailureReason, isUngraded, NO_GRADER_MODEL } from "../core/grade-failure.ts";
import type { Grade } from "../core/mastery.ts";
import { PRACTICE_CONCLUDE_TOOL, type LhMessage } from "../core/native-messages.ts";
import { problemSpanOf, renderProblemSpan, taggedSkillsOf } from "../core/practice-grading.ts";
import { compactionInFlight } from "./compaction.ts";
import { courseForTurn } from "./courses.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/**
 * The real practice grader (owner, 2026-11-09), installed by chat-handler
 * (agent/practice-grade.ts has the seam): the `grader` role grades each tagged
 * skill of a concluded problem.
 *
 * Fallback (owner, 2026-11-13, after a grader slot ran out of credit and nine
 * problems went ungraded unseen): when the grader's model is missing, errors or
 * passes its 2-minute limit, the session's own model grades once, with a
 * 1-minute limit, and the outcome says so. When that fails too, or the session
 * runs on the grader's model anyway, the outcome carries no grades and the
 * reason. It never throws for a model failure, so the turn is never blocked;
 * only a stopped turn (the caller's signal) throws.
 */

const GRADER_TIMEOUT_MS = 120_000;
const FALLBACK_TIMEOUT_MS = 60_000;

type Grades = Array<{ skill: string; grade: Grade }>;
type Attempt = { ok: true; grades: Grades } | { ok: false; reason: string };

/** One grading run on one model; throws on any failure. */
export type GradeRun = (spec: ResolvedModelSpec, signal: AbortSignal) => Promise<Grades>;

async function attempt(spec: ResolvedModelSpec | undefined, run: GradeRun, limitMs: number, signal?: AbortSignal): Promise<Attempt> {
	if (!spec) return { ok: false, reason: NO_GRADER_MODEL };
	const timeout = AbortSignal.timeout(limitMs);
	try {
		const grades = await run(spec, AbortSignal.any([...(signal ? [signal] : []), timeout]));
		return { ok: true, grades };
	} catch (err) {
		if (signal?.aborted) throw err;
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[practice-grade] grading on ${spec.provider}/${spec.id} failed: ${message}`);
		return { ok: false, reason: gradeFailureReason(message, { provider: spec.provider, timedOut: timeout.aborted }) };
	}
}

/** The grader's model first, then the session's own when it is a different one. Pure but for `run`. */
export async function gradeWithFallback(
	specs: { grader: ResolvedModelSpec | undefined; session: ResolvedModelSpec | undefined },
	run: GradeRun,
	signal?: AbortSignal,
	limits: { graderMs: number; fallbackMs: number } = { graderMs: GRADER_TIMEOUT_MS, fallbackMs: FALLBACK_TIMEOUT_MS },
): Promise<GradeOutcome> {
	const { grader, session } = specs;
	const first = await attempt(grader, run, limits.graderMs, signal);
	if (first.ok) return { grades: first.grades };
	const sameModel = grader !== undefined && session !== undefined && grader.provider === session.provider && grader.id === session.id;
	if (!session || sameModel) return { grades: [], gradeError: first.reason };
	const second = await attempt(session, run, limits.fallbackMs, signal);
	if (second.ok) return { grades: second.grades, gradedBy: "session", gradeError: first.reason };
	return { grades: [], gradeError: first.reason };
}

export async function gradeConcludedProblem(input: GradeInput, signal?: AbortSignal, session?: ResolvedModelSpec): Promise<GradeOutcome> {
	const grader = resolveRoleSpec("grader", stores.settingsStore.readSettings());
	return gradeWithFallback({ grader, session }, (spec, runSignal) => gradeProblem(input, { engine: piEngineForSpec(spec), signal: runSignal }), signal);
}

export type RegradeResult = { ok: true } | { ok: false; status: number; error: string };

const BUSY: RegradeResult = { ok: false, status: 409, error: "The tutor is writing right now. Try again when it has finished." };
const busy = (chatId: string): boolean => isTurnRunning(chatId) || compactionInFlight(chatId);

type ToolResult = LhMessage & { role: "toolResult"; toolCallId: string; toolName: string; isError?: boolean; details?: unknown };
const isConcludeResult = (m: LhMessage, callId: string): m is ToolResult => {
	const r = m as Partial<ToolResult>;
	return r.role === "toolResult" && r.toolCallId === callId && r.toolName === PRACTICE_CONCLUDE_TOOL && r.isError !== true;
};

/**
 * "Grade again" (owner, 2026-11-13): grade an ungraded concluded problem from
 * its stored transcript, with the same fallback, and write the grades into that
 * conclude result. This is the one place an earlier message is edited, so it is
 * refused while a turn or a compaction owns the record (their saves replace the
 * whole message list), and the sync merge keeps a graded result over an
 * ungraded copy of it (core/sync-merge.ts). A grading that fails again leaves
 * the record as it was.
 */
export async function regradeConcludedProblem(chatId: string, concludeCallId: string, grader: typeof gradeConcludedProblem = gradeConcludedProblem): Promise<RegradeResult> {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return { ok: false, status: 404, error: "Unknown session" };
	const course = courseForTurn(chatId);
	if (!course?.skills) return { ok: false, status: 404, error: "Not a course practice session" };
	if (busy(chatId)) return BUSY;
	const stored = record.messages.find((m) => isConcludeResult(m, concludeCallId));
	if (!stored) return { ok: false, status: 404, error: "Unknown concluded problem" };
	if (!isUngraded(stored.details)) return { ok: false, status: 409, error: "This problem is already graded" };
	const span = problemSpanOf(record.messages, concludeCallId);
	const tagged = taggedSkillsOf(span);
	if (tagged.length === 0) return { ok: false, status: 400, error: "This problem has no skills to grade" };
	const names = new Map(course.skills().map((s) => [s.id, s.name]));
	const input: GradeInput = {
		skills: tagged.map((id) => ({ id, name: names.get(id) ?? id })),
		transcript: renderProblemSpan(span, concludeCallId),
		difficulty: resolveDifficulty(record.settings),
	};
	const session = resolveConversationSpec(record.settings, effectiveSettings().models.strong) ?? undefined;
	const outcome = await grader(input, undefined, session);
	if (outcome.grades.length === 0) {
		return { ok: false, status: 502, error: outcome.gradeError ? `The grader failed: ${outcome.gradeError}.` : "The grader gave no grades." };
	}
	// No await from here to the save: a turn that started while the grader ran owns the record.
	if (busy(chatId)) return BUSY;
	const fresh = stores.chatStore.getChat(chatId);
	if (!fresh || !fresh.messages.some((m) => isConcludeResult(m, concludeCallId) && isUngraded(m.details))) {
		return { ok: false, status: 409, error: "This problem is already graded" };
	}
	const messages = fresh.messages.map((m) => {
		if (!isConcludeResult(m, concludeCallId)) return m;
		const { grades: _grades, gradedBy: _gradedBy, gradeError: _gradeError, ...rest } = (typeof m.details === "object" && m.details !== null ? m.details : {}) as Record<string, unknown>;
		const details = { ...rest, grades: outcome.grades, ...(outcome.gradedBy ? { gradedBy: outcome.gradedBy } : {}), ...(outcome.gradeError ? { gradeError: outcome.gradeError } : {}) };
		return { ...m, details } as LhMessage;
	});
	stores.chatStore.saveMessages(chatId, messages);
	emit("record-changed", { chatId });
	// the course pages fold understanding from the records: tell them this one moved
	emit("courses-changed", {});
	return { ok: true };
}
