/**
 * The verdict gate (owner, 2026-11-14 — the Diagonalisering lesson on the tablet). PURE, browser-safe.
 *
 * The recall answer was wrong (λ=1, no eigenvectors) and the tutor read it correctly, wrote "I'll note that before
 * moving on" in thinking, then asked about AP=PD with a 230-character lead that said the learner "now has" both
 * eigenvectors. The lead floor passed it: a character count cannot tell a repair from a restatement.
 *
 * The rule, enforced at the tool-call boundary: once the learner has answered a teach question (quiz / explain), the
 * next teach question must say how the tutor graded that answer, in `previous` (right | partly | wrong). When the answer
 * was not right (declared, or recorded as wrong / "don't know" by the answer result itself) the next question must stay
 * on the SAME plan node and be a `check` (a `recall` after a recall miss): the repair goes in `lead`, the step is asked
 * again on a fresh case, and nothing is built on top of it until it lands. A quiz answer recorded as wrong cannot be
 * declared "right". The learner typing a message of his own resets the walk.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { FRESH_CASE } from "./answer-rules.ts";
import { isSteeredResult, readAnswerVerdict } from "./lead-floor-gate.ts";
import { NO_LEAD_GATED_TOOLS } from "./prose-gate.ts";

/** The teach questions the gate guards (the ones that take `previous`). */
export const VERDICT_GATED_TOOLS: readonly string[] = ["quiz", "explain"];

export const PREVIOUS_VERDICTS = ["right", "partly", "wrong", "skipped"] as const;

const GRADED_ANSWER_TOOLS: ReadonlySet<string> = new Set(["quiz", "explain"]);

interface CallLike {
	type: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

export interface VerdictGateProblem {
	kind: "missing" | "contradiction" | "advanced" | "skipped-graded" | "skipped-moved";
	nodeId?: string;
}

function argsOf(block: CallLike | undefined): { nodeId?: unknown; type?: unknown; previous?: unknown } {
	return (block?.arguments && typeof block.arguments === "object" ? block.arguments : {}) as {
		nodeId?: unknown;
		type?: unknown;
		previous?: unknown;
	};
}

/** The question call that a result answers, searched in the history. */
function callOf(history: readonly unknown[], toolCallId: string): CallLike | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i] as { role?: string; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		const hit = (m.content as CallLike[]).find((b) => b.type === "toolCall" && b.id === toolCallId);
		if (hit) return hit;
	}
	return undefined;
}

/**
 * What is wrong with this teach question call, if anything. `history` = the conversation before (or including — it is
 * skipped) the calling message; `args` = the call's arguments. Null for a tool the gate does not guard, for the first
 * question after the learner spoke, and when there is no previous question to read (no graded answer, or a previous
 * question without a nodeId).
 */
export function verdictGateProblem(
	history: readonly unknown[],
	assistantMessage: AssistantMessage,
	toolName: string,
	args: unknown,
): VerdictGateProblem | null {
	if (!VERDICT_GATED_TOOLS.includes(toolName)) return null;
	let answered: ToolResultMessage | undefined;
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i] as { role?: string };
		if (m === assistantMessage || m.role === "assistant") continue;
		if (m.role === "user") return null;
		if (m.role === "toolResult") {
			const result = m as ToolResultMessage;
			// an answered ask_user_question since: the older quiz verdict is stale, nothing to enforce
			if (!result.isError && NO_LEAD_GATED_TOOLS.includes(result.toolName)) return null;
			if (result.isError || !GRADED_ANSWER_TOOLS.has(result.toolName)) continue;
			answered = result;
			break;
		}
	}
	if (!answered) return null;

	const now = (args && typeof args === "object" ? args : {}) as { nodeId?: unknown; type?: unknown; previous?: unknown };
	const declared = typeof now.previous === "string" ? now.previous.trim().toLowerCase() : "";
	if (!(PREVIOUS_VERDICTS as readonly string[]).includes(declared)) return { kind: "missing" };

	const recorded = readAnswerVerdict(answered);
	if (declared === "skipped") {
		// not an answer: nothing was graded, so a recorded verdict contradicts it, and the SAME question comes back
		if (recorded !== undefined) return { kind: "skipped-graded" };
		// a steer may change the plan (owner, 2026-11-18): the tutor re-asks the same step unless what he wrote moves it on
		if (isSteeredResult(answered)) return null;
		const was = argsOf(callOf(history, answered.toolCallId));
		if (typeof was.nodeId !== "string" || was.nodeId === "") return null;
		return now.nodeId === was.nodeId && now.type === was.type ? null : { kind: "skipped-moved", nodeId: was.nodeId };
	}
	if (recorded === "miss" && declared === "right") return { kind: "contradiction" };
	if (declared === "right") return null;

	// a miss: the next question stays on the node and is a check (or a recall after a recall)
	const prior = argsOf(callOf(history, answered.toolCallId));
	if (typeof prior.nodeId !== "string" || prior.nodeId === "") return null;
	const sameNode = now.nodeId === prior.nodeId;
	const allowed = now.type === "check" || (prior.type === "recall" && now.type === "recall");
	return sameNode && allowed ? null : { kind: "advanced", nodeId: prior.nodeId };
}

const TAIL =
	"Put the repair in `lead` (what his answer shows and the step he is missing, worked out), then ask that step again on " + FRESH_CASE + ". ";

/** The refusal text for a problem. */
export function verdictGateReason(problem: VerdictGateProblem): string {
	switch (problem.kind) {
		case "missing":
			return (
				"Refused: the learner has answered, and this question does not say how you graded that answer. Set `previous` to right, " +
				"partly or wrong (the last answer only), then call again. Do not mention this to the learner."
			);
		case "contradiction":
			return (
				"Refused: you set `previous` to right, but his last answer is recorded as wrong or \"don't know\". Set `previous` to wrong " +
				"(or partly), repair it in `lead`, and ask the step again on " + FRESH_CASE + "."
			);
		case "skipped-graded":
			return (
				"Refused: you set `previous` to skipped, but his last answer was recorded with a verdict (right, wrong or \"don't know\"). " +
				"Set `previous` to how it graded. Do not mention this to the learner."
			);
		case "skipped-moved":
			return (
				`Refused: you set \`previous\` to skipped, so nothing was answered. The next question is the same question again: node \`${problem.nodeId}\`, ` +
				"the same type and the same instance. Do not mention this to the learner."
			);
		case "advanced":
			return (
				`Refused: his last answer was not right, so nothing is built on top of it. The next question stays on node \`${problem.nodeId}\` ` +
				"and is type check (type recall again after a recall miss), not predict, final or another node. " +
				TAIL +
				"Do not mention this to the learner."
			);
	}
}
