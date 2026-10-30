/**
 * The phone drawer's finger-following motion (Android phone pass, owner 2026-10-28). The drawer is a fixed panel moved by
 * Tailwind's `translate` utility (`translate-x-0` open, `-translate-x-full` closed). While a finger drags it, an inline
 * `translate` overrides the class and the transition is off, so the panel tracks the finger exactly; on release the
 * inline value animates to where the panel is going to be, and is cleared once it arrives, so the class state that React
 * sets (the same position) takes over without a jump.
 */

const SETTLE_MS = 200; // the drawer's own `duration-200`

/** The inline translate for a drag, kept between fully closed (-100%) and fully open (0): the finger's offset is not
 *  bounded by the swipe recognizer, the drawer must not follow it past either end. `from`: where the drawer was when the
 *  finger went down. */
export function drawerTranslate(from: "open" | "closed", offset: number): string {
	return from === "open" ? `max(${offset}px, -100%) 0` : `min(calc(-100% + ${offset}px), 0px) 0`;
}

/** Follow the finger: no transition, the translate set directly. */
export function dragDrawer(el: HTMLElement, from: "open" | "closed", offset: number): void {
	el.style.transition = "none";
	el.style.translate = drawerTranslate(from, offset);
}

/** Let go: animate to open or closed, then hand the position back to the classes. */
export function releaseDrawer(el: HTMLElement, willBeOpen: boolean): void {
	el.style.transition = `translate ${SETTLE_MS}ms ease`;
	el.style.translate = willBeOpen ? "0 0" : "-100% 0";
	setTimeout(() => {
		el.style.transition = "";
		el.style.translate = "";
	}, SETTLE_MS + 30);
}
