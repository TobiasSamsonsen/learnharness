/**
 * When two touches may pinch and pan the sketch view (owner, 2026-10-31: a resting palm zoomed the canvas). Measured on the
 * Galaxy Tab S10+ (CSS px): a deliberate pinch is exactly two touches, each about 4-5 px and roughly square (at most 7.5), held
 * well over a second. A palm lands as three to seven touches at once, several tall (6x12, 9x11.5, 6.5x15, 19x26.5), and the
 * system takes most of them back within 115 ms. Three rules keep a palm out; pure, so they are tested without a screen.
 *
 * Two later logs on the native-ink surface (owner, 2026-11-06) refined this:
 * - A patch's SHAPE says nothing about a palm: moving fingertips report 2.5x5 and 3x5.5 (an aspect of 1.8 to 2.1 that merges
 *   into the ordinary 1.5 to 1.8 tail), and flagging those cancelled 22 of 50 pinches. Only size is judged.
 * - Size alone cannot tell a thumb from a palm either. A thumb that lies down in a wide pinch reports 9 to 12.5 px (area 57 to
 *   96), the same as the palm fragments of the first log (9.5 to 12 px). What told them apart was the company: every thumb was
 *   in a gesture of exactly two touches, every palm fragment of 9 px or more was down while 4 to 9 touches were. So a big
 *   contact (9 px or more) is a palm only if it was ever down together with three or more touches, and a huge one (14 px or
 *   more: 11.5x14, 9.5x15.5, 20x35 in the logs, thumbs never past 12.5) is a palm on its own.
 * The cost: a lone 9-14 px contact with one finger pans and zooms, so the guard against a resting palm is now the
 * "exactly two touches" rule, which is how the palm shows up in the logs.
 *
 * The wait before a pan starts (owner, 2026-11-06): with 120 ms it was 125 ms in the median, and the fingers travelled 15-24 px
 * in that time (median) without moving the page. A palm's third touch landed 43-44 ms after its first (1 ms in another episode),
 * and replaying all three palm episodes admitted no pinch at any settle of 20 ms or more, so the settle is 60 ms. The motion
 * made while waiting is not lost: the pinch starts from where the fingers LANDED and the page catches up over [PINCH_EASE_MS].
 *
 * Two corrections from a fourth log, with slow, deliberate palm landings (owner, 2026-11-06). That first estimate was too rosy:
 * across 11 episodes the gap from a palm's second touch to its third was 0 to 150 ms (a heel and a finger sat alone for 150 ms
 * before the fragments came). So a pair with a BIG contact (9 px or more, as a heel is within ~70 ms) waits [PINCH_SETTLE_BIG_MS]
 * to open: ordinary fingertips (about 92% of pinches) keep the quick start, a thumb lying down pays 200 ms. The wait gates only
 * the OPENING: a thumb that grows big in a pinch already running does not end it. And a stray third finger-fragment (2x3.5 for
 * 113 ms, in a wide pinch) must not make the thumb a palm, so a cluster is [PALM_CLUSTER_SIZE] = 4 touches: every palm
 * episode in the logs had four or more.
 */
import { pinchOf } from "./view-transform.ts";

/** A pinch begins only once both touches have been down this long (a palm's company lands within ~45 ms). */
export const PINCH_SETTLE_MS = 60;
/** The same wait when a touch of the pair is a big contact (9 px or more): a palm's heel lands alone for up to 150 ms. */
export const PINCH_SETTLE_BIG_MS = 200;
/** The motion the fingers made before the pinch began is paid back to the page over this long. */
export const PINCH_EASE_MS = 100;
/** A contact this wide or tall is big: a lying thumb or a palm, told apart by its company ([PALM_CLUSTER_SIZE]). */
export const PALM_SHAPE_PX = 9;
/** A contact this wide or tall is a palm whatever its company (a thumb peaked at 12.5 px in the log). */
export const PALM_ALWAYS_PX = 14;
/** Touches down together at which every touch then down counts as part of a palm cluster. */
export const PALM_CLUSTER_SIZE = 4;

/** The longer side of a contact patch (CSS px). Missing sizes (a test, an old browser) are 0. */
export function longSide(width: number | undefined, height: number | undefined): number {
	const w = Number.isFinite(width) ? width! : 0;
	const h = Number.isFinite(height) ? height! : 0;
	return Math.max(w, h);
}

/** Is this contact patch big (9 px or more)? Whether that is a palm or a thumb depends on its company. */
export function isBigContact(width: number | undefined, height: number | undefined): boolean {
	return longSide(width, height) >= PALM_SHAPE_PX;
}

/** Is a touch with this peak size a palm, given whether it was ever in a cluster of [PALM_CLUSTER_SIZE]+ touches? */
export function isPalmContact(peakLongSide: number, inCluster: boolean): boolean {
	return peakLongSide >= PALM_ALWAYS_PX || (inCluster && peakLongSide >= PALM_SHAPE_PX);
}

export interface GateTouch {
	/** When the touch landed (the same clock as `now`). */
	downAt: number;
	/** The touch has been judged a palm (sticky: a fingertip's size only grows as it presses). */
	palm: boolean;
	/** The touch has reported a big contact (9 px or more) so far. */
	big?: boolean;
}

/**
 * May these touches pinch right now: exactly two, neither a palm, both settled. A pair with a big contact must be down longer
 * to OPEN a pinch ([PINCH_SETTLE_BIG_MS]); once one runs (`opening` false) the ordinary settle is enough, so a thumb that
 * grows big mid-pinch does not end it.
 */
export function pinchReady(touches: Iterable<GateTouch>, now: number, opening = true): boolean {
	let count = 0;
	let big = false;
	let youngest = Infinity;
	for (const t of touches) {
		count++;
		if (count > 2 || t.palm) return false;
		if (t.big) big = true;
		youngest = Math.min(youngest, now - t.downAt);
	}
	return count === 2 && youngest >= (opening && big ? PINCH_SETTLE_BIG_MS : PINCH_SETTLE_MS);
}

export type Pinch = ReturnType<typeof pinchOf>;

/** A finger the tracker follows (coordinates are the caller's, usually canvas-relative CSS px). */
export interface TrackedTouch extends GateTouch {
	x: number;
	y: number;
	/** The longest side its patch has reported so far. */
	peak: number;
	/** It was down together with [PALM_CLUSTER_SIZE] or more touches at some moment (tagged retroactively, never cleared). */
	cluster: boolean;
}

/** One step of a running pinch: where the fingers were (`prev`, null on the first ready move of a pair that did not land together: a baseline, no jump) and are. */
export interface PinchFrame {
	prev: Pinch | null;
	next: Pinch;
}

/** The motion made before the gate opened, still owed to the page: the fingers' pinch then, minus where they landed. */
interface Debt {
	t0: number;
	dx: number;
	dy: number;
	/** How much farther apart the fingers were than where they landed (1 = no zoom owed). */
	ratio: number;
}

/**
 * The fingers down and the pinch they make, shared by the web canvas and the native-ink surface so the two cannot drift apart.
 * Feed it each touch pointer's down, move and up or cancel; `move` says when the gesture steps. Nothing here knows about the
 * DOM: the caller decides which pointers count (a pen, a mouse and the pen-recency window stay with the caller).
 *
 * The steps it returns are what the page has been SHOWN, which follows the fingers with a lag that fades to nothing over
 * [PINCH_EASE_MS] after the gate opens: the page starts where the fingers landed, so no travel is lost to the wait.
 */
export class PinchTracker {
	private readonly fingers = new Map<number, TrackedTouch>();
	/** What the page has been shown so far (the running pinch), or null when none runs. */
	private baseline: Pinch | null = null;
	/** The pinch of the pair at the moment the second finger landed, while the gate is only waiting for them to settle. */
	private landing: Pinch | null = null;
	private debt: Debt | null = null;

	/** The fingers down, in the order they landed (read-only: the two-finger tap reads it). */
	get touches(): ReadonlyMap<number, TrackedTouch> {
		return this.fingers;
	}

	/** A pinch is running (the canvas starts no stroke meanwhile). */
	get pinching(): boolean {
		return this.baseline !== null;
	}

	has(id: number): boolean {
		return this.fingers.has(id);
	}

	/** A finger landed. Whatever pinch there was starts afresh once the touches pass the gate again. */
	down(id: number, x: number, y: number, width: number | undefined, height: number | undefined, now: number): void {
		this.fingers.set(id, { x, y, downAt: now, palm: false, peak: longSide(width, height), cluster: false });
		this.judge();
		this.baseline = null;
		this.debt = null;
		// a pair that lands together (two touches, neither a palm) pinches from where it landed
		const pair = this.fingers.size === 2 ? [...this.fingers.values()] : [];
		this.landing = pair.length === 2 && !pair.some((t) => t.palm) ? pinchOf(pair[0]!, pair[1]!) : null;
	}

	/** A tracked finger moved; null while the gate is closed or the finger is unknown. */
	move(id: number, x: number, y: number, width: number | undefined, height: number | undefined, now: number): PinchFrame | null {
		const t = this.fingers.get(id);
		if (!t) return null;
		// a fresh record, never a mutation: the two-finger tap keeps references to where the fingers landed (tap-gesture.ts)
		this.fingers.set(id, { ...t, x, y, peak: Math.max(t.peak, longSide(width, height)) });
		this.judge();
		if (!pinchReady(this.fingers.values(), now, this.baseline === null)) {
			this.baseline = null;
			this.debt = null;
			// waiting for the settle keeps the landing; a third touch or a palm ends this pair's chance of a catch-up
			if (this.fingers.size !== 2 || [...this.fingers.values()].some((f) => f.palm)) this.landing = null;
			return null;
		}
		const [a, b] = [...this.fingers.values()];
		const target = pinchOf(a!, b!);
		const opening = this.baseline === null;
		if (opening && this.landing) {
			const l = this.landing;
			this.debt = { t0: now, dx: target.mx - l.mx, dy: target.my - l.my, ratio: l.dist > 0 && target.dist > 0 ? target.dist / l.dist : 1 };
		}
		if (opening) this.landing = null;
		const shown = this.debt ? this.shownAt(target, now) : target;
		const prev = this.baseline ?? (this.debt ? shown : null); // the opening step of a catch-up changes nothing: the page is where the fingers landed
		this.baseline = shown;
		return { prev, next: shown };
	}

	/** A finger lifted or the system took it back: whatever is left starts a fresh baseline. */
	up(id: number): void {
		this.fingers.delete(id);
		this.baseline = null;
		this.landing = null;
		this.debt = null;
	}

	/** Forget the pinch baseline (the fingers stay tracked). */
	reset(): void {
		this.baseline = null;
		this.landing = null;
		this.debt = null;
	}

	/** The pinch the page shows at `now`: the fingers' own, minus the part of the owed motion not yet paid back (linear). */
	private shownAt(target: Pinch, now: number): Pinch {
		const d = this.debt!;
		const owed = Math.max(0, 1 - (now - d.t0) / PINCH_EASE_MS);
		if (owed === 0) this.debt = null;
		return { mx: target.mx - d.dx * owed, my: target.my - d.dy * owed, dist: d.ratio > 0 ? target.dist / d.ratio ** owed : target.dist };
	}

	/** Tag everyone down when a cluster forms (retroactively: a palm's first fragment may land alone), then judge palms. Sticky. */
	private judge(): void {
		const cluster = this.fingers.size >= PALM_CLUSTER_SIZE;
		for (const [id, t] of this.fingers) {
			const inCluster = t.cluster || cluster;
			const palm = t.palm || isPalmContact(t.peak, inCluster);
			const big = t.peak >= PALM_SHAPE_PX;
			if (inCluster !== t.cluster || palm !== t.palm || big !== t.big) this.fingers.set(id, { ...t, cluster: inCluster, palm, big });
		}
	}
}
