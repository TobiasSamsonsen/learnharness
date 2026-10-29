/**
 * The two-finger tap (M16b, the note apps' undo): two fingers touch and lift together, quickly, without travelling. A pinch
 * or a pan moves the fingers, a slow press is a rest; neither counts. Pure, so the rule is tested without a screen.
 */

/** Both fingers must be up within this long of the second touching down. */
export const TAP_MAX_MS = 300;
/** A finger that travels farther than this (CSS px) from where it landed was a pinch or a pan. */
export const TAP_MAX_MOVE = 12;

export interface TapTracker {
	/** When the second finger landed. */
	startedAt: number;
	/** Where each finger landed. */
	starts: Map<number, { x: number; y: number }>;
	/** Fingers lifted so far. */
	lifted: number;
	cancelled: boolean;
}

export function startTap(now: number, fingers: ReadonlyMap<number, { x: number; y: number }>): TapTracker {
	return { startedAt: now, starts: new Map(fingers), lifted: 0, cancelled: false };
}

/** A finger moved (or a third one landed: pass `extra`). Returns the tracker, cancelled when it travelled too far. */
export function moveTap(t: TapTracker, fingers: ReadonlyMap<number, { x: number; y: number }>, extra = false): TapTracker {
	if (t.cancelled) return t;
	let far = extra;
	for (const [id, p] of fingers) {
		const s = t.starts.get(id);
		if (!s) far = true; // a finger that was not there at the start
		else if (Math.hypot(p.x - s.x, p.y - s.y) > TAP_MAX_MOVE) far = true;
	}
	return far ? { ...t, cancelled: true } : t;
}

/** A finger lifted. `tapped` is true when this was the second of the two and the whole thing was quick enough. */
export function liftTap(t: TapTracker, now: number): { tracker: TapTracker; tapped: boolean } {
	if (t.cancelled || now - t.startedAt > TAP_MAX_MS) return { tracker: { ...t, cancelled: true }, tapped: false };
	const lifted = t.lifted + 1;
	return { tracker: { ...t, lifted }, tapped: lifted >= t.starts.size && t.starts.size === 2 };
}
