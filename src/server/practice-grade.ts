import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { gradeProblem, type GradeInput } from "../agent/subagents/grader.ts";
import type { Grade } from "../core/mastery.ts";
import { stores } from "./stores.ts";

/**
 * The real practice grader (owner, 2026-11-09), installed by chat-handler
 * (agent/practice-grade.ts has the seam): the `grader` role grades each tagged
 * skill of a concluded problem. A missing model, an error or the 2-minute
 * timeout throws, and the hook turns that into "no grades" — the outcome's
 * default grade applies and the turn is never blocked.
 */

const GRADER_TIMEOUT_MS = 120_000;

export async function gradeConcludedProblem(input: GradeInput, signal?: AbortSignal): Promise<Array<{ skill: string; grade: Grade }>> {
	const spec = resolveRoleSpec("grader", stores.settingsStore.readSettings());
	if (!spec) throw new Error("no model is configured for the grader role");
	return gradeProblem(input, { engine: piEngineForSpec(spec), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(GRADER_TIMEOUT_MS)]) });
}
