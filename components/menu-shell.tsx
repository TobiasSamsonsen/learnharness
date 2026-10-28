"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { isCoarsePointer } from "./enter-submits.ts";

/**
 * THE shared menu shell (menu standardization, fix wave chunk B): one
 * placement body for the app's dropdown menus — portaled to document.body
 * (never clipped by an ancestor's overflow), fixed-anchored to the trigger's
 * rect, viewport-capped. PLACEMENT-ONLY by design: every site keeps its own
 * open/close/Esc contract (the layered-dismissal machinery differs
 * legitimately by surface — settings sections, the keys editor, the setup
 * dialog each own their Escape).
 *
 *  - Side: each site declares its preferred side — the composer opens UP
 *    (its control sits at screen bottom), the settings rows open DOWN;
 *    the shell flips when the preferred side cannot show the menu's
 *    content and the other side is roomier (the graph popovers'
 *    honest-fitting behavior, generalized).
 *  - Cap: max-height = min(60vh, the chosen side's available room); the
 *    menu scrolls internally instead of stretching the page or escaping
 *    the viewport (graph-view's max-h-[60vh] pattern).
 *  - Width: a menu never leaves the viewport sideways either. Anchored at
 *    the trigger's edge as before while it fits; when its MEASURED width
 *    would cross the screen edge (a 320px menu on a 412px phone, anchored
 *    near the left) it slides back to the EDGE floor, and a menu wider than
 *    the screen is capped to it (Android phone pass, owner 2026-10-28).
 *  - Focus: a menu with a search field focuses it on open, except on touch devices, where the keyboard would cover the
 *    screen the moment a menu opens.
 *  - Re-placement: capture-phase scroll + window resize — the settings
 *    menus' discipline (the settings dialog's inner content scroll
 *    included).
 *
 * Sites (model menus first, owner 2026-09-22; the graph popovers and the
 * stats-bar summary popover stay bespoke — seams stay open for later
 * adoption): the settings Agent section's slot + search-engine menus, the
 * Keys section's Add-provider menu, the composer's model/thinking menus
 * (model-picker.tsx), and the SetupDialog's slot pickers — portaling THOSE
 * out of the dialog's overflow-hidden frame so they extend beyond the
 * dialog exactly like the settings menus (owner, chunk B item 7).
 *
 * SSR: menus only mount client-side while open; the hidden measuring pass
 * below is the only pre-placement render, so a server render never emits
 * a positioned menu.
 */

const GAP = 4; // anchor edge → menu (the bespoke shells' settled 4px)
const EDGE = 8; // viewport floor the menu never enters
const CAP_VH = 0.6; // 60vh — the graph pattern's cap
const MIN_USABLE = 96; // floor: a shorter cap is an unusable sliver; the
// cap then overflows the edge instead of crushing the menu

/** A MenuShell mounted = a dropdown open (fix wave, owner ruling:
 *  the settings dialog's content column locks while any menu is down —
 *  no scrolling under a dropdown). The shell stays placement-only: it
 *  just ANNOUNCES, surfaces decide what to do with the fact (the
 *  settings dialog locks; anything un-lockable keeps the re-place-on-
 *  scroll fallback below). Count-based: overlapping menus open/close in
 *  any order and the accounting stays balanced. */
export const MENU_OPEN_EVENT = "lh:menu-open";
export const MENU_CLOSE_EVENT = "lh:menu-close";

export type MenuSide = "up" | "down";
export type MenuAlign = "left" | "right";

/** One placement decision. `style` is the fixed-position payload; the side
 *  rides back for the flip assertion in tests. */
export interface MenuPlacement {
	side: MenuSide;
	style: Record<string, string | number>;
	maxHeight: number;
	/** The widest the menu may be: the viewport minus the EDGE floor on both sides. */
	maxWidth: number;
}

/** Pure: the placement decision — anchored rect + viewport + the menu's
 *  UNCAPPED content height (scrollHeight, so re-placements after a search
 *  filter re-measure honestly) → side, fixed style, cap. Flip rule: stay
 *  on the preferred side unless it cannot show the full content AND the
 *  other side is roomier. The cap always keeps the menu inside its side's
 *  room when there is room; the floor keeps it usable when there isn't. */
export function computeMenuPlacement(
	rect: { top: number; bottom: number; left: number; right: number },
	viewport: { width: number; height: number },
	contentHeight: number,
	preferredSide: MenuSide,
	align: MenuAlign,
	/** The menu's measured width; 0 = not measured (the anchor edge alone decides, as before). */
	contentWidth = 0,
	/** The system bars (px) the Android shell reports; a menu never opens under the status bar or the gesture bar. */
	safe: { top: number; bottom: number } = { top: 0, bottom: 0 },
): MenuPlacement {
	const availDown = viewport.height - (EDGE + safe.bottom) - (rect.bottom + GAP);
	const availUp = rect.top - GAP - (EDGE + safe.top);
	// contentHeight ≤ 0 (nothing measured yet) keeps the preferred side —
	// the hidden first pass re-measures and decides with real numbers.
	let side = preferredSide;
	if (contentHeight > 0) {
		const preferredAvail = preferredSide === "down" ? availDown : availUp;
		const otherAvail = preferredSide === "down" ? availUp : availDown;
		if (contentHeight > preferredAvail && otherAvail > preferredAvail) {
			side = preferredSide === "down" ? "up" : "down";
		}
	}
	const avail = side === "down" ? availDown : availUp;
	const maxHeight = Math.max(MIN_USABLE, Math.min(CAP_VH * viewport.height, avail));
	const maxWidth = Math.max(0, viewport.width - 2 * EDGE);
	let horizontal: Record<string, number> =
		align === "right" ? { right: viewport.width - rect.right } : { left: rect.left };
	if (contentWidth > 0) {
		// where the menu's left edge lands with the anchor's edge as before, at the width it will really have
		const width = Math.min(contentWidth, maxWidth);
		const left = align === "right" ? rect.right - width : rect.left;
		if (left < EDGE) horizontal = { left: EDGE };
		else if (left + width > viewport.width - EDGE) horizontal = { right: EDGE };
	}
	const vertical: Record<string, number> =
		side === "down" ? { top: rect.bottom + GAP } : { bottom: viewport.height - rect.top + GAP };
	return { side, style: { ...horizontal, ...vertical }, maxHeight, maxWidth };
}

/** The status-bar and gesture-bar heights the Android shell writes as `--lh-safe-top`/`--lh-safe-bottom` (0 elsewhere). */
function safeInsets(): { top: number; bottom: number } {
	// a DOM without computed styles (a test environment) has no system bars to report
	if (typeof getComputedStyle !== "function") return { top: 0, bottom: 0 };
	const css = getComputedStyle(document.documentElement);
	const px = (name: string) => {
		const v = Number.parseFloat(css.getPropertyValue(name));
		return Number.isFinite(v) ? v : 0;
	};
	return { top: px("--lh-safe-top"), bottom: px("--lh-safe-bottom") };
}

/** The shared shell. Exactly one anchor seam: pass `anchorRef` (a live
 *  element ref) or `anchorTestid` (the settings section's pattern — the
 *  trigger is queried by testid at place time). */
export function MenuShell({
	anchorRef,
	anchorTestid,
	testid,
	preferredSide,
	align = "right",
	menuClass,
	children,
}: {
	anchorRef?: RefObject<HTMLElement | null>;
	anchorTestid?: string;
	/** The menu body's own testid (sites assert it). */
	testid: string;
	/** Which way the menu opens from the anchor when both sides fit. */
	preferredSide: MenuSide;
	/** Which anchor edge the menu's horizontal position keys off. */
	align?: MenuAlign;
	/** The menu body classes: width, border, bg, padding, text — the
	 *  shell adds position, z-index, the height cap, and scrolling. */
	menuClass: string;
	children: ReactNode;
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [placed, setPlaced] = useState<MenuPlacement | null>(null);
	const focusedOnceRef = useRef(false);

	// Announce open↔close for lockable surfaces (see MENU_OPEN_EVENT).
	useEffect(() => {
		window.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT));
		return () => {
			window.dispatchEvent(new CustomEvent(MENU_CLOSE_EVENT));
		};
	}, []);

	// Focus on open (owner, fix wave): the search menus land focus IN the
	// search; menus without one land it on the body (tabIndex -1 below) so
	// the arrow machine has a home. Once only — re-placements (scroll/
	// resize) must never steal focus back mid-walk. The lists' own mount
	// focus runs during the hidden measuring pass, where focus() silently
	// fails (visibility: hidden subtrees are not focusable) — this seam is
	// the one that actually lands.
	useEffect(() => {
		if (placed === null || focusedOnceRef.current) return;
		focusedOnceRef.current = true;
		const el = menuRef.current;
		if (!el) return;
		const input = el.querySelector<HTMLElement>("input");
		// Touch (owner, 2026-10-28): opening a menu must not raise the soft keyboard over the screen; the learner taps the field
		// when they want to type. The body takes focus instead, like a menu without a search.
		(input && !isCoarsePointer() ? input : el).focus();
	}, [placed]);

	// The standard arrow machine for menus WITHOUT a search (owner: when a
	// dropdown is expanded, the arrow keys cycle the options and never
	// scroll the screen): ArrowDown/Up move DOM focus among the option
	// buttons with WRAP, Home/End hit the ends; Enter activates the
	// focused button natively. Search menus own their arrows inside the
	// input (their clamped-walk machine, 2026-09-17) — those events never
	// bubble here, and the input/textarea guard is belt-and-braces.
	const onBodyKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		const { key } = e;
		if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
		const buttons = Array.from(
			menuRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [],
		);
		if (buttons.length === 0) return;
		e.preventDefault();
		if (key === "Home") {
			buttons[0]?.focus();
			return;
		}
		if (key === "End") {
			buttons[buttons.length - 1]?.focus();
			return;
		}
		const delta = key === "ArrowDown" ? 1 : -1;
		const idx = buttons.findIndex((b) => b === document.activeElement);
		// From the body (nothing focused yet): ArrowDown enters at the FIRST
		// option, ArrowUp at the last — the native-select convention.
		const base = idx === -1 ? (delta > 0 ? -1 : 0) : idx;
		const next = (base + delta + buttons.length) % buttons.length;
		buttons[next]?.focus();
	};

	const anchor = () => {
		if (anchorRef) return anchorRef.current;
		if (anchorTestid !== undefined) return document.querySelector(`[data-testid="${anchorTestid}"]`);
		return null;
	};

	// Measure + (re)place: on mount, then on every capture-phase scroll and
	// resize (rAF-throttled). scrollHeight keeps the flip decision honest
	// after the content changes shape (a search filtering the list).
	useLayoutEffect(() => {
		let raf = 0;
		const place = () => {
			const el = anchor();
			if (!el || !menuRef.current) return;
			const p = computeMenuPlacement(
				el.getBoundingClientRect(),
				{ width: window.innerWidth, height: window.innerHeight },
				menuRef.current.scrollHeight,
				preferredSide,
				align,
				menuRef.current.offsetWidth,
				safeInsets(),
			);
			setPlaced(p);
		};
		place();
		const rePlace = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(place);
		};
		window.addEventListener("scroll", rePlace, true);
		window.addEventListener("resize", rePlace);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("scroll", rePlace, true);
			window.removeEventListener("resize", rePlace);
		};
	}, [anchorRef, anchorTestid, preferredSide, align]);

	// First pass: mounted hidden at the viewport's top-left so the layout
	// effect can measure the real content height before anything is seen.
	// The menu is positioned ONCE and then only re-anchored — no flash.
	if (placed === null) {
		return createPortal(
			<div
				ref={menuRef}
				data-testid={testid}
				data-lh-menu=""
				style={{ position: "fixed", left: 0, top: 0, visibility: "hidden" }}
				className={menuClass}
			>
				{children}
			</div>,
			document.body,
		);
	}
	return createPortal(
		<div
			ref={menuRef}
			data-testid={testid}
			data-lh-menu=""
			tabIndex={-1}
			onKeyDown={onBodyKeyDown}
			style={{ position: "fixed", zIndex: 60, ...placed.style, maxHeight: placed.maxHeight, maxWidth: placed.maxWidth, overflowY: "auto" }}
			// The body is the arrow machine's focus home (input-less menus
			// land focus here on open) — the focus STAYS, but the browser's
			// default blue ring around it must not draw (owner, polish
			// round). Arrow cycling moves DOM focus to the buttons, which
			// carry their own hover/highlight; the ring is pure noise.
			className={`${menuClass} outline-none`}
		>
			{children}
		</div>,
		document.body,
	);
}