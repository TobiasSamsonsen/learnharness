/**
 * When two touches may pinch and pan the sketch view (owner, 2026-10-31: a resting palm zoomed the canvas). Measured on the
 * Galaxy Tab S10+ (CSS px): a deliberate pinch is exactly two touches, each about 4-5 px and roughly square (at most 7.5), held
 * well over a second. A palm lands as three to seven touches at once, several tall (6x12, 9x11.5, 6.5x15, 19x26.5), and the
 * system takes most of them back within 115 ms. Three rules keep a palm out; pure, so they are tested without a screen.
 */

/** A pinch begins only once both touches have been down this long (a palm is mostly cancelled by then). */
export const PINCH_SETTLE_MS = 120;
/** A touch whose contact patch is this wide or tall is a palm, not a fingertip. */
export const PALM_SHAPE_PX = 9;
/** A patch at least this much longer than wide (and past [PALM_SHAPE_MIN_PX]) is a palm edge, not a fingertip. */
export const PALM_SHAPE_ASPECT = 1.8;
/** Below this the reported size is noise (a fingertip's first report is often 0.5 x 1): the aspect is not judged. */
export const PALM_SHAPE_MIN_PX = 5;

/** Is this contact patch (CSS px) shaped like a palm? Missing sizes (a test, an old browser) are never a palm. */
export function isPalmShaped(width: number | undefined, height: number | undefined): boolean {
	const w = Number.isFinite(width) ? width! : 0;
	const h = Number.isFinite(height) ? height! : 0;
	const long = Math.max(w, h);
	const short = Math.min(w, h);
	if (long >= PALM_SHAPE_PX) return true;
	return long >= PALM_SHAPE_MIN_PX && short > 0 && long / short >= PALM_SHAPE_ASPECT;
}

export interface GateTouch {
	/** When the touch landed (the same clock as `now`). */
	downAt: number;
	/** The touch has ever reported a palm-shaped patch (sticky: a fingertip's size only grows as it presses). */
	palm: boolean;
}

/** May these touches pinch right now: exactly two, neither palm-shaped, both settled. */
export function pinchReady(touches: Iterable<GateTouch>, now: number): boolean {
	let count = 0;
	for (const t of touches) {
		count++;
		if (count > 2 || t.palm || now - t.downAt < PINCH_SETTLE_MS) return false;
	}
	return count === 2;
}
