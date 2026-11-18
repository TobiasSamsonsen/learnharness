/**
 * Wording the tutor reads in several places (owner, 2026-11-18), kept in one spot so the gates, the answer results, the pace
 * texts and the hint prompts cannot drift apart.
 */

/** What "fresh case" means when a step is asked again: in the Taylor lesson a node was asked three times and each retry was bigger
 *  (a four-part derivation, then a higher order with a bound and a self-check). */
export const FRESH_CASE =
	"a fresh case of the SAME size (the same number of steps and parts: nothing added, no extra part, no higher order, no self-check he was not asked before; smaller if he was stuck)";

/** What the tutor reads with a steer (owner, 2026-11-18): the learner set the open question aside and wrote to the tutor instead.
 *  Not an answer: nothing is graded, and the same step comes back unless the message changes the plan. */
export const STEER_NEXT_TEXT =
	"He did not answer: he set this question aside and wrote to you instead (`steer`). It is NOT an answer: grade nothing, and any hints in `hints` do not make it an aided answer. " +
	"Reply to what he says first, in the next question's `lead`. Then ask the same step again (set `previous` to skipped; same nodeId and type, and do not repeat the hints already given) " +
	"unless what he says changes the plan: then change the plan and say so in one line. " +
	"Do not plan the reply in thinking: only text and `lead` reach him.";

/** The hint side of the same rule. */
export const HINT_NOTATION_RULE = "A valid, equivalent notation (his course's own) is never the thing to point at: point only at what is mathematically wrong.";

/** The same session: the learner wrote their course's notation and was corrected for it while the real errors went unnamed. */
export const NOTATION_RULE =
	"Repair only what is mathematically wrong. A valid, equivalent notation is never an error (his course's own, such as (x−a)^k for h^k, or a bound written M): " +
	"when his course writes it differently from how you taught it, use his, and name the real slip (a dropped exponent, a bound written as a term).";
