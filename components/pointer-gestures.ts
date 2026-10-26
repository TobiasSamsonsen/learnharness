/**
 * Touch gestures for the pan/zoom viewports (M5, tablet pass): one pointer
 * pans, two pointers pan by their centroid and zoom by their spread. Pure on
 * purpose, like pan-zoom.ts — whose fit-floor math it composes — so the
 * overlays (skill map, plan popup, session overlay) share ONE behavior and
 * tests pin it without live pointer events (tests/pointer-gestures.test.ts).
 *
 * The model is anchor-based: a gesture remembers the view and the pointer
 * positions it started from, and every move maps "pointers now" onto "view
 * then". A finger joining or leaving re-anchors at the CURRENT view, so the
 * content never jumps when the finger count changes.
 */

import { fitGraphView, zoomedGraphView, type Viewport } from "./pan-zoom.ts";

export interface Pt {
	x: number;
	y: number;
}

/** What a gesture needs to know about the surface it moves. */
export interface GestureSurface {
	/** The zoom floor (the fit). Panning locks here; pinching out stops here. */
	floor: number;
	box: { w: number; h: number };
	viewport: { w: number; h: number };
}

const centroid = (pts: readonly Pt[]): Pt => ({
	x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
	y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});

const spread = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The view for pointers now (`to`) given the view at the anchor and the
 * pointers there (`from`, same length, same order). One pointer pans (locked
 * at the floor — nothing to move); two pan by the centroid and zoom by the
 * spread ratio keeping the anchor centroid's content under the new centroid.
 * More than two pointers use the first two. Pure.
 */
export function gestureView(start: Viewport, from: readonly Pt[], to: readonly Pt[], surface: GestureSurface): Viewport {
	const eps = 1e-9;
	const [f0, f1] = from;
	const [t0, t1] = to;
	if (!f0 || !t0 || to.length < from.length) return start;
	if (!f1 || !t1) {
		if (start.zoom <= surface.floor + eps) return start;
		return { ...start, x: start.x + (t0.x - f0.x), y: start.y + (t0.y - f0.y) };
	}
	const c0 = centroid([f0, f1]);
	const c1 = centroid([t0, t1]);
	const d0 = spread(f0, f1);
	const d1 = spread(t0, t1);
	const factor = d0 > eps ? d1 / d0 : 1;
	const zoomed = zoomedGraphView(start, factor, surface.floor, c0, surface.box, surface.viewport);
	// At the floor the fit re-centers: there is nothing to pan.
	if (zoomed.zoom <= surface.floor + eps) return fitGraphView(surface.box, surface.viewport, surface.floor);
	return { ...zoomed, x: zoomed.x + (c1.x - c0.x), y: zoomed.y + (c1.y - c0.y) };
}

/**
 * Tracks the live pointers of ONE surface. `down`/`up` return nothing and
 * re-anchor; `move` returns the new view, or null when the moved pointer is
 * not tracked or the gesture has nothing to do. Positions are in the
 * viewport's own coordinates (the caller subtracts the element's rect once).
 */
export class GestureTracker {
	private pointers = new Map<number, Pt>();
	private anchor: { view: Viewport; pts: Pt[] } | null = null;
	/** True once any move has changed the view — the caller's "user adjusted". */
	moved = false;

	get count(): number {
		return this.pointers.size;
	}

	private reanchor(view: Viewport): void {
		this.anchor = this.pointers.size === 0 ? null : { view, pts: [...this.pointers.values()].map((p) => ({ ...p })) };
	}

	down(id: number, p: Pt, view: Viewport): void {
		this.pointers.set(id, { ...p });
		this.reanchor(view);
	}

	move(id: number, p: Pt, surface: GestureSurface): Viewport | null {
		if (!this.pointers.has(id) || !this.anchor) return null;
		this.pointers.set(id, { ...p });
		const now = [...this.pointers.values()];
		// The anchor holds the pointers in insertion order too (Map keeps it).
		const next = gestureView(this.anchor.view, this.anchor.pts, now, surface);
		if (next !== this.anchor.view) this.moved = true;
		return next;
	}

	/** A finger lifted (or the browser cancelled it). `view` is the CURRENT
	 *  view. Returns whether the gesture moved the view — and, when this was
	 *  the last finger, resets that flag for the next gesture. */
	up(id: number, view: Viewport): boolean {
		const moved = this.moved;
		if (!this.pointers.delete(id)) return false;
		this.reanchor(view);
		if (this.pointers.size === 0) this.moved = false;
		return moved;
	}

	clear(): void {
		this.pointers.clear();
		this.anchor = null;
		this.moved = false;
	}
}
