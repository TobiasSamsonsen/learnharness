/**
 * The Adapt pass (fork addition, 2026-11-11): one submit call that reads an
 * evidence digest (core/learner-digest.ts) and drafts claims about the
 * learner. Runs on the `grader` role, which resolves to the strong slot, so no
 * new model role exists. The draft is never stored: the learner edits it and
 * presses Apply (the Settings page), and only then does it reach new sessions.
 *
 * The instructions are code, not an editable prompt fragment.
 */

import { Type } from "typebox";
import { LEARNER_CLAIMS_MAX, LEARNER_CLAIM_KINDS, LEARNER_CLAIM_TEXT_MAX } from "../../core/learner.ts";
import { CLAIM_MIN_CHATS, CLAIM_MIN_EVENTS, adaptProblem, type AdaptSubmission } from "../../core/learner-digest.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

const INSTRUCTIONS = `You study the learning history of ONE learner and draft short, factual claims about them that a tutor can use in later sessions. You read only the evidence digest you are given: concluded practice problems (outcome, hint rung, miss class, the tutor's verdict) and per-lesson tallies of quiz and probe answers (wrong, wrong at high stated confidence, "I don't know"). Nothing else is known about them.

Claim kinds:
- mistake: a recurring way they go wrong (for example a miss class that keeps coming back, or the same slip across topics).
- calibration: how their stated confidence relates to being right (for example overconfidence on answers that turn out wrong).
- what-helped: something in the evidence that preceded a good outcome (for example a hint rung that was enough, or solving without hints after a certain kind of task).
- pacing: how fast or slow they need to be taken, only if the evidence shows it.

Rules:
- Every claim must be supported by the digest. Cite the chat ids it rests on, copied exactly from the digest lines ("CHAT <id>"), and the number of events (concluded problems or answers) behind it. Never invent an id, a count, or an event.
- A claim needs at least ${CLAIM_MIN_EVENTS} events in at least ${CLAIM_MIN_CHATS} chats to be solid. You may submit a weaker one with fewer; it is marked tentative for the learner. Prefer fewer, stronger claims over many weak ones.
- Describe what happened, not who they are: no labels, no personality, no advice to the tutor. Plain statements, each at most ${LEARNER_CLAIM_TEXT_MAX} characters. At most ${LEARNER_CLAIMS_MAX} claims.
- Say nothing about whether they learn better from pictures, proofs, examples or any other presentation unless the digest actually shows it (it normally does not: the presentation of each explanation is not recorded). Instead, state plainly in \`gaps\` what the evidence could not show, one short sentence each, for example "No evidence about which kind of explanation works best for them." Always include a gap for presentation style when you make no claim about it.
- Write in English.`;

export const adaptSchema = Type.Object({
	claims: Type.Array(
		Type.Object({
			kind: Type.Union(LEARNER_CLAIM_KINDS.map((k) => Type.Literal(k)), { description: `One of: ${LEARNER_CLAIM_KINDS.join(", ")} — bare word, no quotes.` }),
			text: Type.String({ description: `The claim, at most ${LEARNER_CLAIM_TEXT_MAX} characters.` }),
			events: Type.Integer({ minimum: 1, description: "How many events in the digest support it." }),
			chats: Type.Array(Type.String(), { description: "The chat ids (from the digest) the claim rests on." }),
		}),
		{ description: `At most ${LEARNER_CLAIMS_MAX} claims.` },
	),
	gaps: Type.Array(Type.String(), { description: "What the evidence could not show, one short sentence each." }),
});

export function adaptPrompt(digestText: string): string {
	return ["EVIDENCE DIGEST (newest chats first):", "", digestText].join("\n");
}

/** Draft the claims for a digest. Throws when the model never submits. */
export async function draftLearnerClaims(digestText: string, deps: { engine: PiEngine | undefined; signal?: AbortSignal }): Promise<AdaptSubmission> {
	return runSubmitAgent<AdaptSubmission>({
		role: "grader",
		toolName: "submit_profile",
		toolDescription: "Submit the drafted claims and the gaps in the evidence.",
		parameters: adaptSchema,
		fill: (v: Partial<AdaptSubmission>) => ({ claims: v.claims ?? [], gaps: v.gaps ?? [] }),
		validate: adaptProblem,
		systemPrompt: INSTRUCTIONS,
		prompt: adaptPrompt(digestText),
		engine: deps.engine,
		signal: deps.signal,
		onStep: () => {},
		neverSubmitted: "the Adapt pass never submitted",
		maxTurns: 4,
	});
}
