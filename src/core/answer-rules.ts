/**
 * Wording the tutor reads in several places (owner, 2026-11-18), kept in one spot so the gates, the answer results, the pace
 * texts and the hint prompts cannot drift apart.
 */

/** What "fresh case" means when a step is asked again: in the Taylor lesson a node was asked three times and each retry was bigger
 *  (a four-part derivation, then a higher order with a bound and a self-check). */
export const FRESH_CASE =
	"a fresh case of the SAME size (the same number of steps and parts: nothing added, no extra part, no higher order, no self-check he was not asked before; smaller if he was stuck)";

/** The hint side of the same rule. */
export const HINT_NOTATION_RULE = "A valid, equivalent notation (his course's own) is never the thing to point at: point only at what is mathematically wrong.";

/** The same session: the learner wrote their course's notation and was corrected for it while the real errors went unnamed. */
export const NOTATION_RULE =
	"Repair only what is mathematically wrong. A valid, equivalent notation is never an error (his course's own, such as (x−a)^k for h^k, or a bound written M): " +
	"when his course writes it differently from how you taught it, use his, and name the real slip (a dropped exponent, a bound written as a term).";
