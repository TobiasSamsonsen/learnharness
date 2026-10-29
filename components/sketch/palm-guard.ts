"use client";

import { useEffect, type RefObject } from "react";

/**
 * The palm guard for the sketch view's toolbar (owner, 2026-10-29, docs/android/m16-plan.md): a resting hand must not press
 * buttons while the pen writes. The canvas already ignores a touch within PALM_GUARD_MS of the pen (sketch-canvas.tsx); the
 * toolbar gets the same rule, plus one for the contact size of a palm. Nothing here blocks the pen or a mouse, and a person
 * who never used a pen is never affected (a palm is only a problem next to a pen).
 */

/** A touch this soon after the pen was last near (touching or hovering) is a palm, not a finger. */
export const PALM_GUARD_MS = 600;
/** A touch whose contact patch is this wide or tall (CSS px) is a palm, once a pen has been seen. Provisional: measured on the phone. */
export const PALM_CONTACT_PX = 30;

const state = { penAt: -Infinity, penSeen: false };

/** The pen touched the screen or hovered over it just now. */
export function notePenNear(now: number = performance.now()): void {
	state.penAt = now;
	state.penSeen = true;
}

export interface TouchLike {
	pointerType: string;
	width: number;
	height: number;
}

/** Is this press a palm? Pure apart from the module's pen memory (`penAt`, `penSeen` are injectable for tests). */
export function isPalmTouch(e: TouchLike, now: number = performance.now(), penAt: number = state.penAt, penSeen: boolean = state.penSeen): boolean {
	if (e.pointerType !== "touch") return false;
	if (now - penAt < PALM_GUARD_MS) return true;
	return penSeen && Math.max(e.width, e.height) >= PALM_CONTACT_PX;
}

/** Test seam: forget the pen. */
export function resetPalmGuard(): void {
	state.penAt = -Infinity;
	state.penSeen = false;
}

/** Swallow palm presses inside `ref` (capture phase, so no child sees them), and the click such a press would still produce. */
export function usePalmGuard(ref: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		let swallowClick = false;
		let timer: number | undefined;
		const onDown = (e: PointerEvent) => {
			if (e.pointerType === "pen") {
				notePenNear();
				return;
			}
			if (!isPalmTouch(e)) return;
			e.preventDefault();
			e.stopPropagation();
			swallowClick = true;
			window.clearTimeout(timer);
			timer = window.setTimeout(() => (swallowClick = false), 800);
		};
		const onClick = (e: MouseEvent) => {
			if (!swallowClick) return;
			swallowClick = false;
			e.preventDefault();
			e.stopPropagation();
		};
		el.addEventListener("pointerdown", onDown, true);
		el.addEventListener("click", onClick, true);
		return () => {
			window.clearTimeout(timer);
			el.removeEventListener("pointerdown", onDown, true);
			el.removeEventListener("click", onClick, true);
		};
	}, [ref]);
}
