"use client";

/**
 * ENTER SUBMITS — regardless of where focus is (owner round 6, 2026-10-05).
 * The dictation reality: the learner dictates into the dock's field without
 * ever focusing it, so Enter must submit from ANYWHERE — body focus, a
 * scroll, a stray link. The field's own Enter handler still fires first
 * when it IS focused (this listener sits at the window level, bubble's last
 * stop) — one law, two entry points, no double submit (the focused field's
 * handler claims the event via its own keydown; this hook skips typing
 * surfaces entirely).
 *
 * What the window listener refuses to touch:
 * - typing surfaces (input/textarea/select/contenteditable) — the focused
 *   surface owns its Enter (the dock field, the composer, settings);
 * - modified Enter (⇧↵ is a newline, ⌘/Ctrl↵ belongs to the surface).
 *
 * BUTTONS — the pointer/keyboard split (owner, keyboard round 2026-10-10):
 * a mouse click on a transcript control (a thinking toggle, a copy button)
 * leaves focus ON that button; the learner's next Enter must SUBMIT, not
 * re-activate the toggle — the report that born this rule. But two button
 * populations keep native Enter-activates:
 *   1. KEYBOARD-focused buttons — :focus-visible means focus arrived by
 *      keyboard (the arrow-walked menus; Tab is dead app-wide, so this
 *      only happens inside overlays);
 *   2. buttons inside an OPEN OVERLAY — menus walk focus with arrows and
 *      Enter activates the walked button natively (menu-shell's contract),
 *      dialogs are their own surfaced layer (the ONE-ESC LAW's layers).
 * The pointer-clicked transcript button fails both tests → Enter is ours
 * (preventDefault also suppresses the browser's default activation, so
 * the toggle does not fire underneath the submit).
 *
 * The submit callbacks self-guard (empty thinking / canSubmit) — this hook
 * never checks answer validity, only focus honesty.
 */

import { useEffect, useRef } from "react";
import { isTypingSurface } from "@/src/core";

/** A PHYSICAL keyboard has been used (owner, M13e: a tablet with a keyboard attached, like the Tab S10+ with its
 *  Book Cover Keyboard, behaves like a PC for Enter). The soft keyboard (an IME) reports "Unidentified" or no
 *  `code`, or composes; a hardware key carries a `code` ("KeyA", "Enter") and a real `key`. Latched for the page:
 *  one real key press flips it, and `data-lh-keyboard` on <html> lets CSS show the Enter hint again. */
let hardwareKeyboard = false;

/** Feed it every keydown (the window-level capture listener below does). */
export function noteKeydown(e: { key: string; code?: string; isComposing?: boolean }): void {
	if (hardwareKeyboard) return;
	if (!e.code || e.key === "Unidentified" || e.key === "Process" || e.isComposing === true) return;
	hardwareKeyboard = true;
	try {
		document.documentElement.dataset.lhKeyboard = "hardware";
	} catch {
		// no document (SSR, a test host): the flag alone is enough
	}
}

export function hasHardwareKeyboard(): boolean {
	return hardwareKeyboard;
}

/** For tests: forget the latch. */
export function resetHardwareKeyboard(): void {
	hardwareKeyboard = false;
	try {
		delete document.documentElement.dataset.lhKeyboard;
	} catch {
		// no document
	}
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
	window.addEventListener("keydown", (e) => noteKeydown(e), true);
}

/** Touch devices (M5, owner): the PRIMARY pointer is coarse. Read at event
 *  time — no hook, no re-render, no hydration question — and guarded for
 *  hosts without matchMedia (linkedom, SSR). A tablet with a keyboard
 *  attached counts as coarse only until a physical key is pressed (M13e);
 *  after that plain Enter sends there like on a PC. */
export function isCoarsePointer(): boolean {
	if (hardwareKeyboard) return false;
	try {
		return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
	} catch {
		return false;
	}
}

/** THE chord every text field shares: does this keydown SEND? Enter sends
 *  and Shift+Enter is a newline — except on a coarse pointer, where plain
 *  Enter is a newline too (the soft keyboard's return key) and the send
 *  button submits; ⌘/Ctrl+Enter sends everywhere. Pure given `coarse`. */
export function enterSends(
	e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
	coarse: boolean = isCoarsePointer(),
): boolean {
	if (e.key !== "Enter") return false;
	if (e.metaKey || e.ctrlKey) return true;
	return !e.shiftKey && !coarse;
}

/** Overlay roots whose buttons keep native Enter (hand-rolled menus mark
 *  themselves data-lh-menu; Radix poppers/dialogs carry their own attrs). */
const OVERLAY_ROOTS = '[data-lh-menu], [data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]';

/** Pure decision, exported for pins: does a focused BUTTON keep native
 *  Enter (true) or does Enter belong to submit (false)? */
export function buttonKeepsNativeEnter(el: HTMLElement): boolean {
	// Keyboard-walked focus: the menu arrows landed here — Enter activates.
	// (Guarded: a selector engine without the pseudo — linkedom in the
	// test harness — degrades to "not keyboard focus", never throws on
	// every Enter.)
	try {
		if (el.matches(":focus-visible")) return true;
	} catch {
		// unsupported pseudo — treat as pointer focus
	}
	// Inside an open overlay: the overlay owns its keys.
	return !!el.closest(OVERLAY_ROOTS);
}

/** Mount-scoped: while the dock is mounted (a problem/question is active),
 *  plain Enter anywhere outside a typing surface or button submits it. */
export function useEnterSubmits(submit: () => void): void {
	const submitRef = useRef(submit);
	submitRef.current = submit;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Enter") return;
			if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			if (isTypingSurface(e)) return;
			const target = e.target as HTMLElement | null;
			if (target?.tagName === "BUTTON" && buttonKeepsNativeEnter(target)) return;
			e.preventDefault();
			submitRef.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}
