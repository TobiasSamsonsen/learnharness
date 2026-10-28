/**
 * Swipe recognition for the phone UI (Android phone pass, owner goal 2026-10-28). Pure on purpose: the recognizer is
 * a small state machine over pointer samples, so the thresholds that decide "scroll or swipe?" are pinned by tests and
 * the DOM wiring (use-swipe.ts) stays thin.
 *
 * A gesture starts PENDING at pointer-down. Once the finger has moved past the slop it is decided once: if the motion
 * runs along the swipe's axis (and the way the swipe allows) it becomes ACTIVE and follows the finger; otherwise it is
 * REJECTED and left to the browser (a vertical scroll must never turn into a sideways swipe). On release an active swipe
 * COMMITS when it travelled far enough or was flicked fast enough in the allowed direction.
 */

export type SwipeAxis = "x" | "y";
/** Which way along the axis counts: "neg" = left/up, "pos" = right/down, "both". */
export type SwipeWay = "neg" | "pos" | "both";

export interface SwipeConfig {
	axis: SwipeAxis;
	way: SwipeWay;
	/** Distance along the axis (px) at which a release commits. */
	commitDistance: number;
	/** Movement (px) before the gesture is decided. */
	slop?: number;
	/** The axis must dominate the cross axis by this factor, or the gesture is rejected (a scroll). */
	ratio?: number;
	/** Release speed (px/ms) that commits a shorter swipe (a flick). */
	flickVelocity?: number;
	/** A flick must still have moved at least this far (px). */
	flickMinDistance?: number;
}

export type SwipePhase = "idle" | "pending" | "active" | "rejected";

export interface SwipeState {
	phase: SwipePhase;
	/** Signed distance along the axis, limited to the allowed way (0 when pending or rejected). */
	offset: number;
}

export interface SwipeEnd {
	commit: boolean;
	offset: number;
	/** px/ms along the axis over the last 100 ms (signed). */
	velocity: number;
}

const DEFAULTS = { slop: 10, ratio: 1.6, flickVelocity: 0.5, flickMinDistance: 24 };

export interface SwipeTracker {
	down(x: number, y: number, t: number): void;
	move(x: number, y: number, t: number): SwipeState;
	up(t: number): SwipeEnd;
	cancel(): void;
	readonly state: SwipeState;
}

export function createSwipeTracker(config: SwipeConfig): SwipeTracker {
	const c = { ...DEFAULTS, ...config };
	let phase: SwipePhase = "idle";
	let sx = 0;
	let sy = 0;
	let offset = 0;
	let samples: Array<{ d: number; t: number }> = [];

	const allowed = (d: number) => (c.way === "both" ? d : c.way === "neg" ? Math.min(0, d) : Math.max(0, d));

	return {
		down(x, y, t) {
			phase = "pending";
			sx = x;
			sy = y;
			offset = 0;
			samples = [{ d: 0, t }];
		},
		move(x, y, t) {
			if (phase === "pending") {
				const dx = x - sx;
				const dy = y - sy;
				const along = c.axis === "x" ? dx : dy;
				const across = c.axis === "x" ? dy : dx;
				if (Math.max(Math.abs(dx), Math.abs(dy)) >= c.slop) {
					const wrongWay = allowed(along) === 0 && along !== 0;
					phase = !wrongWay && Math.abs(along) >= c.ratio * Math.abs(across) ? "active" : "rejected";
				}
			}
			if (phase === "active") {
				const d = c.axis === "x" ? x - sx : y - sy;
				offset = allowed(d);
				samples.push({ d: offset, t });
				// keep only the last ~100 ms for the release velocity
				while (samples.length > 2 && t - samples[0]!.t > 100) samples.shift();
			}
			return { phase, offset: phase === "active" ? offset : 0 };
		},
		up(t) {
			const wasActive = phase === "active";
			let velocity = 0;
			if (wasActive && samples.length >= 2) {
				const a = samples[0]!;
				const b = samples[samples.length - 1]!;
				const dt = Math.max(1, Math.max(t, b.t) - a.t);
				velocity = (b.d - a.d) / dt;
			}
			const along = Math.abs(offset);
			const flickDir = c.way === "neg" ? velocity < 0 : c.way === "pos" ? velocity > 0 : velocity !== 0 && Math.sign(velocity) === Math.sign(offset);
			const commit = wasActive && (along >= c.commitDistance || (Math.abs(velocity) >= c.flickVelocity && along >= c.flickMinDistance && flickDir));
			const out = { commit, offset: wasActive ? offset : 0, velocity };
			phase = "idle";
			offset = 0;
			samples = [];
			return out;
		},
		cancel() {
			phase = "idle";
			offset = 0;
			samples = [];
		},
		get state() {
			return { phase, offset: phase === "active" ? offset : 0 };
		},
	};
}
