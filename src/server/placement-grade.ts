import { piEngineForSpec, type ResolvedModelSpec } from "../agent/models.ts";
import type { PlacementGradeOutcome } from "../agent/placement-grade.ts";
import { gradePlacementAnswer, type PlacementGradeInput } from "../agent/subagents/placement-grader.ts";
import { gradeFailureReason, NO_GRADER_MODEL } from "../core/grade-failure.ts";
import type { Grade } from "../core/mastery.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { stores } from "./stores.ts";

const GRADER_TIMEOUT_MS = 90_000;
const FALLBACK_TIMEOUT_MS = 60_000;

type Attempt = { ok: true; grade: Grade } | { ok: false; reason: string };

async function attempt(
	spec: ResolvedModelSpec | undefined,
	run: (spec: ResolvedModelSpec, signal: AbortSignal) => Promise<Grade>,
	limitMs: number,
	signal?: AbortSignal,
): Promise<Attempt> {
	if (!spec) return { ok: false, reason: NO_GRADER_MODEL };
	const timeout = AbortSignal.timeout(limitMs);
	try {
		const grade = await run(spec, AbortSignal.any([...(signal ? [signal] : []), timeout]));
		return { ok: true, grade };
	} catch (err) {
		if (signal?.aborted) throw err;
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[placement-grade] grading on ${spec.provider}/${spec.id} failed: ${message}`);
		return { ok: false, reason: gradeFailureReason(message, { provider: spec.provider, timedOut: timeout.aborted }) };
	}
}

export async function gradePlacementSubmissionServer(
	input: PlacementGradeInput,
	signal?: AbortSignal,
	session?: ResolvedModelSpec,
): Promise<PlacementGradeOutcome> {
	const grader = resolveRoleSpec("grader", stores.settingsStore.readSettings());
	const first = await attempt(grader, (spec, runSignal) => gradePlacementAnswer(input, { engine: piEngineForSpec(spec), signal: runSignal }), GRADER_TIMEOUT_MS, signal);
	if (first.ok) return { grade: first.grade };
	const sameModel = grader !== undefined && session !== undefined && grader.provider === session.provider && grader.id === session.id;
	if (!session || sameModel) return { gradeError: first.reason };
	const second = await attempt(session, (spec, runSignal) => gradePlacementAnswer(input, { engine: piEngineForSpec(spec), signal: runSignal }), FALLBACK_TIMEOUT_MS, signal);
	if (second.ok) return { grade: second.grade, gradedBy: "session", gradeError: first.reason };
	return { gradeError: first.reason };
}
