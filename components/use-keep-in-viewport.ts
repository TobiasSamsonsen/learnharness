import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Android phone pass (owner goal, 2026-10-28: popups must not go off the screen). The app's own absolutely positioned
 * popovers (the stats summary, the coverage ring) are sized for a desktop and centered or right-aligned on a small
 * trigger, so on a 412px phone they left the screen. After they mount, this measures the box and shifts it sideways
 * with margins (not `transform`: Tailwind's translate utilities already own that) until it lies inside the viewport.
 */

const EDGE = 8; // the viewport floor popups never enter (the same 8px as the shared menu shell)

/** Pure: how far to move a box sideways (positive = right) so it lies inside [edge, viewportWidth - edge]. 0 when it
 *  already fits; a box wider than the room goes flush to the left edge. */
export function horizontalShift(rect: { left: number; right: number }, viewportWidth: number, edge = EDGE): number {
	const room = viewportWidth - 2 * edge;
	if (rect.right - rect.left >= room || rect.left < edge) return edge - rect.left;
	if (rect.right > viewportWidth - edge) return viewportWidth - edge - rect.right;
	return 0;
}

/** Attach the returned ref to the popover; it re-fits on mount and on every resize (rotation, the keyboard). */
export function useKeepInViewport<T extends HTMLElement>(active: boolean): RefObject<T | null> {
	const ref = useRef<T>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!active || !el) return;
		const fit = () => {
			// start from the unshifted position, then move by what is needed; margin-left moves a box anchored by
			// `left`, margin-right (the opposite sign) one anchored by `right`
			el.style.marginLeft = "0px";
			el.style.marginRight = "0px";
			const shift = horizontalShift(el.getBoundingClientRect(), window.innerWidth);
			if (shift !== 0) {
				el.style.marginLeft = `${shift}px`;
				el.style.marginRight = `${-shift}px`;
			}
		};
		fit();
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	}, [active]);
	return ref;
}
