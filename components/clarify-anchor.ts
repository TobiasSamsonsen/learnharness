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

/** The passages of one native message (a message can have several text parts). */
export function passagesOf(root: ParentNode, messageId: string): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(PASSAGE_SELECTOR)].filter((p) => p.getAttribute("data-source-message-id") === messageId);
}

/** The first non-empty line of the marked text, whitespace collapsed and capped: what the page searches for. */
export function anchorText(quote: string): string {
	const first = quote.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
	return first.length > CLARIFY_ANCHOR_MAX ? first.slice(0, CLARIFY_ANCHOR_MAX).trimEnd() : first;
}

/** Every place `text` appears in the message's passages, in document order (fresh Ranges). */
export function anchorRanges(root: ParentNode, messageId: string, text: string): Range[] {
	return passagesOf(root, messageId).flatMap((passage) => sessionPassageRanges(passage, text));
}

/** The place an anchor points at now. An occurrence that no longer exists falls back to the nearest one; null when the text is gone. */
export function findAnchorRange(root: ParentNode, anchor: ClarifyAnchor): Range | null {
	const ranges = anchorRanges(root, anchor.messageId, anchor.text);
	if (ranges.length === 0) return null;
	return ranges[Math.min(anchor.occurrence, ranges.length - 1)]!;
}

/**
 * The anchor and the full marked text for a live selection, or null: the selection must sit inside ONE lesson passage
 * (not in the quiz dock, not across messages) and contain displayed text.
 */
export function anchorFromSelection(root: ParentNode, range: Range): { anchor: ClarifyAnchor; quote: string } | null {
	const node = range.commonAncestorContainer;
	const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
	const passage = element?.closest<HTMLElement>(PASSAGE_SELECTOR);
	if (!passage) return null;
	const messageId = passage.getAttribute("data-source-message-id");
	if (!messageId) return null;
	const quote = markedQuote(sessionDisplayText(passage, range));
	if (!quote) return null;
	const text = anchorText(quote);
	if (!text) return null;
	// which occurrence: the first match that starts inside the selection
	const matches = anchorRanges(root, messageId, text);
	const inside = typeof range.comparePoint === "function" ? matches.findIndex((m) => range.comparePoint(m.startContainer, m.startOffset) === 0) : -1;
	return { anchor: { messageId, text, occurrence: Math.max(inside, 0) }, quote };
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
