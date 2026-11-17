/**
 * A long text block that lands all at once (owner, 2026-11-17: the plan text).
 * It is placed with its first line about a quarter of the way down the screen,
 * with one smooth scroll, instead of gliding to the end of the block; and its
 * words fade in over a fixed sweep, like streaming that has already happened.
 * Token-by-token text keeps following the bottom as before. PURE, browser-safe.
 */

/** Where the first line of a landed long block sits, as a fraction of the viewport height. */
export const BLOCK_TOP_FRACTION = 0.25;

/** The whole word-by-word reveal takes about this long, whatever the length. */
export const REVEAL_MS = 1200;

/** A text this long at its first render landed all at once (a streamed text starts with a few characters). */
export const LANDED_MIN_CHARS = 120;

export const isLandedText = (text: string): boolean => text.length >= LANDED_MIN_CHARS;

/** A block this much of the screen or taller is read from its start, so its start is brought up. */
export const TALL_BLOCK_FRACTION = 0.5;

export const isLongBlock = (blockHeight: number, viewportHeight: number): boolean =>
	viewportHeight > 0 && blockHeight > viewportHeight * TALL_BLOCK_FRACTION;

/** The per-word delay that makes the whole sweep last REVEAL_MS, within sane bounds. */
export function revealStagger(words: number): number {
	const raw = REVEAL_MS / Math.max(words, 1);
	return Math.min(40, Math.max(0.5, raw));
}

export const wordCount = (text: string): number => (text.trim() === "" ? 0 : text.trim().split(/\s+/).length);

export interface BlockScrollInput {
	/** The block's top, measured from the top of the scrollable content. */
	blockTop: number;
	viewportHeight: number;
	scrollHeight: number;
}

/** The scrollTop that puts the block's first line at BLOCK_TOP_FRACTION of the viewport, kept inside the scroll range. */
export function blockScrollTarget({ blockTop, viewportHeight, scrollHeight }: BlockScrollInput): number {
	const max = Math.max(0, scrollHeight - viewportHeight);
	const target = blockTop - viewportHeight * BLOCK_TOP_FRACTION;
	return Math.min(max, Math.max(0, Math.round(target)));
}
