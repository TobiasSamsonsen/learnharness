/**
 * Is this thinking signature a narration block's? PURE, browser-safe (atob, no Buffer).
 *
 * The Anthropic API turns some of the tutor's reply text into a second "thinking" block whose opaque signature header
 * names it `narration` (decoded: first 60 bytes). It is the tutor's own wording of what it means to say, never real
 * reasoning, and it must not reach the learner as a thinking row (owner, 2026-11-14 — the Diagonalisering lesson).
 */
export function isNarrationSignature(signature: unknown): boolean {
	if (typeof signature !== "string" || signature === "") return false;
	try {
		return atob(signature.slice(0, 80)).slice(0, 60).includes("narration");
	} catch {
		return false;
	}
}
