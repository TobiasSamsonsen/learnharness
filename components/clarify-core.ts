import { CLARIFY_QUOTE_MAX } from "@/src/core";

/**
 * Pure seams of the clarification feature (owner design, 2026-11-01; margin threads 2026-11-02): the learner marks text in
 * the learning text and asks about it in a bubble beside the line. The anchor logic is components/clarify-anchor.ts, the
 * floating button components/ask-selection.tsx, the bubbles and the card components/clarify-layer.tsx.
 */

/** The marked text as the Ask button offers it: trimmed, empty → null, capped
 *  at what the server accepts (line breaks between blocks are kept — the
 *  tutor reads the passage as the learner saw it). */
export function markedQuote(raw: string): string | null {
	const text = raw.trim();
	if (!text) return null;
	return text.length > CLARIFY_QUOTE_MAX ? text.slice(0, CLARIFY_QUOTE_MAX).trimEnd() : text;
}

/** The text of an error reply from the clarify route. */
export async function clarifyErrorText(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: unknown; message?: unknown };
		if (typeof body.error === "string" && body.error) return body.error;
		if (typeof body.message === "string" && body.message) return body.message;
	} catch {
		// not JSON — the generic line below
	}
	return `The question could not be sent (${res.status}).`;
}
