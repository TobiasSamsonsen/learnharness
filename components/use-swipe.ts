import { useEffect, useRef, type RefObject } from "react";
import { createSwipeTracker, type SwipeConfig } from "./swipe.ts";

/**
 * The DOM wiring for components/swipe.ts (Android phone pass, owner goal 2026-10-28). Touch only (a mouse or a stylus
 * keeps its own behavior), one finger, and never on a control that owns the drag itself (a range slider, a text field,
 * anything marked `data-no-swipe`). The element and its descendants get the CROSS axis as `touch-action` (`pan-y` for a
 * sideways swipe, via the data-swipe-x/y attribute and app/globals.css) so the browser keeps scrolling vertically and
 * hands the horizontal motion to us; a vertical scroll that starts on the
 * element is rejected by the recognizer and the browser cancels the pointer, which ends the gesture quietly.
 *
 * Once a swipe is active the pointer is captured, the swipe's offset is reported on every move, and the click that
 * would follow the release is swallowed (a swipe must not also press the row or button under the finger).
 */

export interface SwipeHandlers {
	/** The gesture was decided to be a swipe (once per gesture). */
	onStart?: () => void;
	/** The signed distance along the axis, limited to the allowed way. */
	onMove?: (offset: number) => void;
	/** The finger lifted (or the pointer was cancelled: commit false, offset 0). */
	onEnd?: (end: { commit: boolean; offset: number }) => void;
}

const OWN_DRAG = 'input, textarea, select, [data-no-swipe], [contenteditable="true"]';

/** `external`: attach to an element whose ref the caller already owns (the returned ref is then that one). */
export function useSwipe<T extends HTMLElement>(
	config: SwipeConfig,
	handlers: SwipeHandlers,
	enabled = true,
	external?: RefObject<T | null>,
	/** A selector for descendants that own a competing gesture: a swipe that starts inside one is not this swipe's (the
	 *  drawer's close swipe must not fire for a sideways swipe that belongs to a row inside it). */
	ignore?: string,
): RefObject<T | null> {
	const own = useRef<T>(null);
	const ref = external ?? own;
	// the latest handlers and config without re-subscribing the listeners on every render
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;
	const configRef = useRef(config);
	configRef.current = config;

	useEffect(() => {
		const el = ref.current;
		if (!enabled || !el) return;
		const c = configRef.current;
		// the attribute carries the cross-axis `touch-action` down to scrolling children too (app/globals.css)
		const attr = c.axis === "x" ? "data-swipe-x" : "data-swipe-y";
		el.setAttribute(attr, "");
		const tracker = createSwipeTracker(c);
		let pointerId: number | null = null;
		let started = false;

		const swallowNextClick = () => {
			const stop = (e: Event) => {
				e.stopPropagation();
				e.preventDefault();
			};
			window.addEventListener("click", stop, { capture: true, once: true });
			// a swipe that ends without a click must not leave the trap armed for the next real tap
			setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 400);
		};

		const down = (e: PointerEvent) => {
			if (e.pointerType !== "touch" || !e.isPrimary || pointerId !== null) return;
			if (e.target instanceof Element && (e.target.closest(OWN_DRAG) || (ignore && e.target.closest(ignore)))) return;
			pointerId = e.pointerId;
			started = false;
			tracker.down(e.clientX, e.clientY, e.timeStamp);
		};
		const move = (e: PointerEvent) => {
			if (e.pointerId !== pointerId) return;
			const s = tracker.move(e.clientX, e.clientY, e.timeStamp);
			if (s.phase === "active") {
				if (!started) {
					started = true;
					try {
						el.setPointerCapture(e.pointerId);
					} catch {
						// the pointer is already gone; the gesture just ends
					}
					handlersRef.current.onStart?.();
				}
				handlersRef.current.onMove?.(s.offset);
			}
		};
		const finish = (e: PointerEvent, cancelled: boolean) => {
			if (e.pointerId !== pointerId) return;
			pointerId = null;
			if (cancelled) {
				tracker.cancel();
				if (started) handlersRef.current.onEnd?.({ commit: false, offset: 0 });
			} else {
				const end = tracker.up(e.timeStamp);
				if (started) {
					swallowNextClick();
					handlersRef.current.onEnd?.({ commit: end.commit, offset: end.offset });
				}
			}
			started = false;
		};
		const up = (e: PointerEvent) => finish(e, false);
		const cancel = (e: PointerEvent) => finish(e, true);

		el.addEventListener("pointerdown", down);
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
		el.addEventListener("pointercancel", cancel);
		return () => {
			el.removeEventListener("pointerdown", down);
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
			el.removeEventListener("pointercancel", cancel);
			el.removeAttribute(attr);
		};
	}, [enabled, config.axis, config.way, ignore]);

	return ref;
}
