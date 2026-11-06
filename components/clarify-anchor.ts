import { CLARIFY_ANCHOR_MAX, type ClarifyAnchor } from "@/src/core";
import { sessionDisplayText, sessionPassageRanges } from "@/components/session-find-dom";
import { markedQuote } from "@/components/clarify-core";

/**
 * Where a margin thread hangs on the learning text (owner design, 2026-11-02). A thread is anchored to a passage of the
 * lesson prose by the native message it sits in, the first line of the marked text as DISPLAYED (KaTeX's hidden MathML copy
 * is left out, as in Find) and which occurrence of that text within the message it is — enough to re-find the line after
 * a reload, when the DOM is rebuilt. Nothing here holds a Range across renders: a Range goes stale when the text re-renders.
 */

/** A lesson text passage: the prose of one tutor message part (chat.tsx: .lh-source-passage). */
export const PASSAGE_SELECTOR = ".lh-source-passage[data-source-message-id]";

/** The wording of a question or practice problem is a passage too, tagged with the call it belongs to (ClarifyWording). */
export const CALL_ATTRIBUTE = "data-source-call-id";

/** The passages of one native message (a message can have several text parts). With `callId`, only the wording of that
 *  question; without, only the lesson prose: a question's words never answer for the lesson's, nor the other way round. */
export function passagesOf(root: ParentNode, messageId: string, callId?: string): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(PASSAGE_SELECTOR)].filter(
		(p) => p.getAttribute("data-source-message-id") === messageId && (p.getAttribute(CALL_ATTRIBUTE) ?? undefined) === callId,
	);
}

/** The first non-empty line of the marked text, whitespace collapsed and capped: what the page searches for. */
export function anchorText(quote: string): string {
	const first = quote.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
	return first.length > CLARIFY_ANCHOR_MAX ? first.slice(0, CLARIFY_ANCHOR_MAX).trimEnd() : first;
}

/** Every place `text` appears in the message's passages, in document order (fresh Ranges). */
export function anchorRanges(root: ParentNode, messageId: string, text: string, callId?: string): Range[] {
	return passagesOf(root, messageId, callId).flatMap((passage) => sessionPassageRanges(passage, text));
}

/** The place an anchor points at now. An occurrence that no longer exists falls back to the nearest one; null when the text is gone. */
export function findAnchorRange(root: ParentNode, anchor: ClarifyAnchor): Range | null {
	const ranges = anchorRanges(root, anchor.messageId, anchor.text, anchor.callId);
	if (ranges.length === 0) return null;
	return ranges[Math.min(anchor.occurrence, ranges.length - 1)]!;
}

/** Is boundary a strictly before boundary b (document order)? */
function pointBefore(a: { node: Node; offset: number }, b: { node: Node; offset: number }): boolean {
	if (a.node === b.node) return a.offset < b.offset;
	return (a.node.compareDocumentPosition(b.node) & 4 /* DOCUMENT_POSITION_FOLLOWING */) !== 0;
}

/**
 * Every line of the marked text, as the page shows it now: one Range per line of the stored `quote` (a selection over several
 * paragraphs, list items or formulas is several lines, because Find's display model never matches across blocks, and the quote
 * was read with the same model). The first line is the one the bubble anchors to (same occurrence); each later line is searched
 * for after the previous one, in the same passage. A line that cannot be found is skipped, so what was found stays marked; an
 * anchor whose first line is gone gives none.
 */
export function findQuoteRanges(root: ParentNode, anchor: ClarifyAnchor, quote: string): Range[] {
	const first = findAnchorRange(root, anchor);
	if (!first) return [];
	const lines = quote.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
	const passage = passagesOf(root, anchor.messageId, anchor.callId).find((p) => p.contains(first.startContainer));
	if (lines.length === 0 || !passage) return [first];
	// the anchor line is capped (CLARIFY_ANCHOR_MAX): a longer first line is widened to its full text where it starts at the same place
	let head = first;
	if (lines[0]!.length > anchor.text.length) {
		const full = sessionPassageRanges(passage, lines[0]!).find((r) => r.startContainer === first.startContainer && r.startOffset === first.startOffset);
		if (full) head = full;
	}
	const ranges = [head];
	let after = { node: head.endContainer, offset: head.endOffset };
	for (const line of lines.slice(1)) {
		const next = sessionPassageRanges(passage, line).find((r) => !pointBefore({ node: r.startContainer, offset: r.startOffset }, after));
		if (!next) continue;
		ranges.push(next);
		after = { node: next.endContainer, offset: next.endOffset };
	}
	return ranges;
}

/**
 * The anchor and the full marked text for a live selection, or null: the selection must sit inside ONE passage (a lesson
 * passage, or the wording of one question or problem; not across messages, and not in an option or a field) and contain
 * displayed text.
 */
export function anchorFromSelection(root: ParentNode, range: Range): { anchor: ClarifyAnchor; quote: string } | null {
	const node = range.commonAncestorContainer;
	const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
	const passage = element?.closest<HTMLElement>(PASSAGE_SELECTOR);
	if (!passage) return null;
	const messageId = passage.getAttribute("data-source-message-id");
	if (!messageId) return null;
	const callId = passage.getAttribute(CALL_ATTRIBUTE) || undefined;
	const quote = markedQuote(sessionDisplayText(passage, range));
	if (!quote) return null;
	const text = anchorText(quote);
	if (!text) return null;
	// which occurrence: the first match that starts inside the selection
	const matches = anchorRanges(root, messageId, text, callId);
	const inside = typeof range.comparePoint === "function" ? matches.findIndex((m) => range.comparePoint(m.startContainer, m.startOffset) === 0) : -1;
	return { anchor: { messageId, text, occurrence: Math.max(inside, 0), ...(callId ? { callId } : {}) }, quote };
}

/** Bubbles on neighbouring lines would stack on top of each other: push each one down to at least `gap` below the last. */
export function spreadBubbles(tops: readonly number[], gap: number): number[] {
	const order = tops.map((top, index) => ({ top, index })).sort((a, b) => a.top - b.top || a.index - b.index);
	const out: number[] = new Array(tops.length).fill(0);
	let last = -Infinity;
	for (const { top, index } of order) {
		const placed = Math.max(top, last + gap);
		out[index] = placed;
		last = placed;
	}
	return out;
}
