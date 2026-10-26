"use client";

/**
 * The pointer wiring for a pan/zoom viewport (skill map, plan popup, session
 * overlay): the DOM half of components/pointer-gestures.ts. A mouse drags as
 * it always did; touch adds two-finger pan + pinch.
 *
 * `touchPanNeedsTwo` is the inline skill map's rule (owner, M5): one finger
 * on the map belongs to the PAGE scroll (the viewport is touch-action:
 * pan-y), two fingers belong to the map. Chrome claims a one-finger vertical
 * pan for the page and then cancels our pointer, which is fine — a cancel is
 * just "that finger is gone". The second finger needs help, though: unless
 * its touchmove is prevented, Chrome may take the two-finger drag as a page
 * pan too, so a non-passive touchmove listener prevents it once two fingers
 * are down (the pointer events then keep flowing).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { Viewport } from "./pan-zoom.ts";
import { GestureTracker, type GestureSurface } from "./pointer-gestures.ts";

export function usePanZoomGestures({
	viewportRef,
	view,
	setView,
	surface,
	onAdjusted,
	touchPanNeedsTwo = false,
}: {
	viewportRef: RefObject<HTMLElement | null>;
	view: Viewport;
	setView: (v: Viewport) => void;
	surface: GestureSurface;
	/** The learner moved the view themselves (stops auto-fitting). */
	onAdjusted: () => void;
	touchPanNeedsTwo?: boolean;
}) {
	const trackerRef = useRef<GestureTracker | null>(null);
	trackerRef.current ??= new GestureTracker();
	const tracker = trackerRef.current;
	// Latest values for handlers that outlive a render (a gesture spans many).
	const live = useRef({ view, surface, setView, onAdjusted, touchPanNeedsTwo });
	live.current = { view, surface, setView, onAdjusted, touchPanNeedsTwo };
	const [panning, setPanning] = useState(false);

	useEffect(() => {
		const el = viewportRef.current;
		if (!el || !touchPanNeedsTwo) return;
		const guard = (e: TouchEvent) => {
			if (e.touches.length >= 2 && e.cancelable) e.preventDefault();
		};
		el.addEventListener("touchmove", guard, { passive: false });
		return () => el.removeEventListener("touchmove", guard);
	}, [viewportRef, touchPanNeedsTwo]);

	const local = (e: ReactPointerEvent<HTMLElement>) => {
		const rect = e.currentTarget.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	};

	const onPointerDown = useCallback(
		(e: ReactPointerEvent<HTMLElement>) => {
			if (e.pointerType === "mouse" && e.button !== 0) return;
			if ((e.target as HTMLElement).closest("button")) return;
			tracker.down(e.pointerId, local(e), live.current.view);
			// At the floor a lone pointer has nothing to move: stay out of the
			// way (no capture, no grabbing cursor) — a second finger can still join.
			if (tracker.count === 1 && live.current.view.zoom <= live.current.surface.floor + 1e-9) return;
			setPanning(true);
			e.currentTarget.setPointerCapture?.(e.pointerId);
		},
		[tracker],
	);

	const onPointerMove = useCallback(
		(e: ReactPointerEvent<HTMLElement>) => {
			const { surface: s, setView: set, touchPanNeedsTwo: two } = live.current;
			// A lone touch on the inline map is the page's scroll, not ours.
			if (two && e.pointerType === "touch" && tracker.count < 2) return;
			const next = tracker.move(e.pointerId, local(e), s);
			if (next) {
				if (tracker.count >= 2) setPanning(true);
				set(next);
			}
		},
		[tracker],
	);

	const onPointerEnd = useCallback(
		(e: ReactPointerEvent<HTMLElement>) => {
			const moved = tracker.up(e.pointerId, live.current.view);
			if (moved) live.current.onAdjusted();
			if (tracker.count === 0) setPanning(false);
		},
		[tracker],
	);

	return {
		panning,
		handlers: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd },
	};
}
