import { judgeChecker, judgeQuestionRun, judgeVerifyRun, pythonBlocks, unsafePythonReason } from "../core/answer-check.ts";
import { figureFacts, judgeFigureCheck } from "../core/figures/index.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { checkQuestion } from "../agent/subagents/answer-checker.ts";
import type { ResolvedQuiz } from "../agent/question-verify.ts";
import { runPython } from "./python-run.ts";
import { stores } from "./stores.ts";

/**
 * The real answer-key check (owner, 2026-10-25 — core/answer-check.ts has
 * the rules), installed by chat-handler for every multiple-choice question:
 *
 *   1. `verify` — the author's program must print the correct label.
 *   2. The question's one python block, run as-is: printing the key's
 *      label proves it; printing another option's label refuses.
 *   3. Otherwise the `checker` role solves the question blind, with what
 *      the run showed as facts. A disagreement refuses ONCE: the same
 *      question sent again unchanged goes through (the author re-solved and
 *      stands by it — the checker can be wrong too).
 *
 * Fails open: no Python, no checker model, a checker error or its
 * 2-minute timeout never blocks a question. LH_ANSWER_CHECK=0 turns the
 * whole check off.
 */

const CHECKER_TIMEOUT_MS = 120_000;

/** Questions the checker already refused once (fingerprints, newest last). */
const refusedOnce: string[] = [];

const fingerprint = (q: ResolvedQuiz) => JSON.stringify([q.question, q.details ?? "", q.keyed, q.correct, q.multiSelect === true]);

export async function checkQuizKey(q: ResolvedQuiz, signal?: AbortSignal): Promise<string[]> {
	if (process.env.LH_ANSWER_CHECK === "0" || q.correct.length === 0) return [];
	const multi = q.multiSelect === true;
	const facts: string[] = [];
	// Figures (owner, 2026-10-26): a stated figure quantity is computed and
	// compared first — a match proves the key; every figure's computed
	// response becomes a fact for the second model.
	const texts = [q.question, q.details ?? "", q.explanation ?? "", ...q.keyed.map((o) => o.label)];
	if (q.figureCheck) {
		const verdict = judgeFigureCheck(texts, q.keyed, q.correct, q.figureCheck);
		if (verdict.problems.length > 0 || verdict.verified) return verdict.problems;
	}
	facts.push(...figureFacts(texts));

	if (q.verify?.trim()) {
		const unsafe = unsafePythonReason(q.verify);
		if (unsafe) return [`Your \`verify\` program ${unsafe} — a verify program only computes and prints (no files, processes, network or dynamic code).`];
		const run = await runPython(q.verify, signal);
		if (run) {
			const verdict = judgeVerifyRun(q.keyed, q.correct, run, multi);
			if (verdict.problems.length > 0 || verdict.verified) return verdict.problems;
		}
	}

	const blocks = pythonBlocks([q.question, q.details ?? ""].join("\n\n"));
	if (blocks.length === 1 && !unsafePythonReason(blocks[0]!)) {
		const run = await runPython(blocks[0]!, signal);
		if (run) {
			const verdict = judgeQuestionRun(q.keyed, q.correct, run, multi);
			if (verdict.problems.length > 0 || verdict.verified) return verdict.problems;
			facts.push(...verdict.facts);
		}
	}

	const fp = fingerprint(q);
	if (refusedOnce.includes(fp)) return [];
	const spec = resolveRoleSpec("checker", stores.settingsStore.readSettings());
	if (!spec || signal?.aborted) return [];
	try {
		const verdict = await checkQuestion(
			{ question: q.question, details: q.details, options: q.keyed, multiSelect: multi, facts },
			{ engine: piEngineForSpec(spec), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(CHECKER_TIMEOUT_MS)]) },
		);
		const problems = judgeChecker(q.keyed, q.correct, verdict);
		if (problems.length > 0) {
			refusedOnce.push(fp);
			if (refusedOnce.length > 500) refusedOnce.shift();
		}
		return problems;
	} catch (err) {
		if (!signal?.aborted) console.warn(`[answer-check] checker failed, question passes unchecked: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}
