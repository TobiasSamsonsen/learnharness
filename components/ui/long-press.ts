/**
 * The long-press state machine behind touch tooltips (M5, owner: "long-press
 * shows the label"). Pure — the timers live in Hint; this decides what each
 * event does — because the SSR render tests run no effects or timers and a
 * hold/slop/swallow rule is exactly what regresses silently.
 *
 *   idle ──down(touch)──▶ armed ──fire──▶ shown ──hide──▶ idle
 *                           │ move past slop / up / cancel
 *                           ▼
 *                         idle
 *
 * Mouse and pen never arm (Radix's hover and focus handle them as before).
 * `shown` carries `swallow`: the release of the press that showed the label
 * must not ALSO activate the button, so the next click is eaten once. A fresh
 * `down` clears it, so a stale flag can never eat a real tap.
 */

/** Hold time before the label shows (ms): the rest delay of hover tooltips. */
export const LONG_PRESS_MS = 500;
/** Finger travel (px) that turns a hold into a scroll or drag. */
export const LONG_PRESS_SLOP = 10;
/** How long the label stays up after it shows (ms). */
export const LONG_PRESS_SHOW_MS = 2000;

export type LongPress =
	| { phase: "idle" }
	| { phase: "armed"; x: number; y: number }
	| { phase: "shown"; swallow: boolean };

export type LongPressEvent =
	| { type: "down"; x: number; y: number; pointerType: string }
	| { type: "move"; x: number; y: number }
	| { type: "up" }
	| { type: "cancel" }
	| { type: "fire" }
	| { type: "click" }
	| { type: "hide" };

export const LONG_PRESS_IDLE: LongPress = { phase: "idle" };

export function longPress(state: LongPress, ev: LongPressEvent): LongPress {
	switch (ev.type) {
		case "down":
			return ev.pointerType === "touch" ? { phase: "armed", x: ev.x, y: ev.y } : LONG_PRESS_IDLE;
		case "move":
			if (state.phase !== "armed") return state;
			return Math.hypot(ev.x - state.x, ev.y - state.y) > LONG_PRESS_SLOP ? LONG_PRESS_IDLE : state;
		case "up":
		case "cancel":
			// A release or a browser cancel ends a hold that never fired; once the
			// label is up it stays up (the release is what arms the swallow).
			return state.phase === "armed" ? LONG_PRESS_IDLE : state;
		case "fire":
			return state.phase === "armed" ? { phase: "shown", swallow: true } : state;
		case "click":
			return state.phase === "shown" && state.swallow ? { phase: "shown", swallow: false } : state;
		case "hide":
			return LONG_PRESS_IDLE;
	}
}

/** Should this click be eaten? (The release of the press that showed the label.) */
export function swallowsClick(state: LongPress): boolean {
	return state.phase === "shown" && state.swallow;
}

/** Should the browser's own long-press menu (contextmenu) be suppressed? Any
 *  touch hold on a hinted control is ours, not the browser's link preview. */
export function ownsContextMenu(state: LongPress): boolean {
	return state.phase !== "idle";
}
