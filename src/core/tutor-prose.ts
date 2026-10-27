/**
 * The tutor's prose, wherever it lives (owner, 2026-10-27). The teach
 * questions (quiz / explain) carry the reply the learner reads in a REQUIRED
 * `lead` argument, so it can no longer be drafted in thinking and dropped.
 * Everything that reads "what the tutor said" — the prose gate, the view
 * projection, knowledge extraction, export, dictation vocabulary, the
 * compaction summary — goes through here, so a lead counts exactly like a
 * text block written before the call. PURE, browser-safe.
 */

/** The tools whose calls carry a `lead`. */
export const LEAD_TOOLS: readonly string[] = ["quiz", "explain"];

interface BlockLike {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

/** The lead of a question call, or "" (not a lead tool, none, or blank). */
export function leadOf(block: BlockLike): string {
	if (block.type !== "toolCall" || !block.name || !LEAD_TOOLS.includes(block.name)) return "";
	const lead = (block.arguments as { lead?: unknown } | null | undefined)?.lead;
	return typeof lead === "string" && lead.trim() !== "" ? lead : "";
}

/** The prose of one assistant message, in order: each text block and each
 *  question call's lead. A call listed in `rejected` (an authoring failure the
 *  learner never saw posed) contributes nothing. */
export function tutorProse(content: readonly BlockLike[], rejected?: ReadonlySet<string>): string[] {
	const out: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			if ((block.text ?? "").trim() !== "") out.push(block.text!);
		} else {
			const lead = leadOf(block);
			if (lead && !(block.id && rejected?.has(block.id))) out.push(lead);
		}
	}
	return out;
}
