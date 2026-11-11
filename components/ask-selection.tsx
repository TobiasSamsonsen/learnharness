"use client";

import { useEffect, useState } from "react";
import { MessageSquareIcon } from "lucide-react";
import type { SelectionAction } from "@/components/selection-toolbar";
import type { ClarifyAnchor } from "@/src/core";
import { anchorFromSelection } from "@/components/clarify-anchor";

/**
 * The floating "Ask" button (owner design, 2026-11-01; margin threads 2026-11-02): marking text in the learning text offers
 * an "Ask about this" button beside the selection; pressing it hands the marked text and its anchor to the margin layer,
 * which opens a thread on that line. It never takes focus or collapses the selection (pointerdown is prevented), so native
 * copy and the touch handles keep working. The offer is for passages only (clarify-anchor.ts): the lesson prose and the wording
 * of a question or problem (its stem and context, in the dock or in the answered card); options, fields and chrome are not.
 */

/** What the button hands over: the marked text as displayed, and where it sits. */
export interface AskMark {
	quote: string;
	anchor: ClarifyAnchor;
}

interface Mark extends AskMark {
	/** Viewport coordinates of the button's anchor (the selection's edge). */
	x: number;
	y: number;
}

/**
 * The same offer as one more action on the shared selection toolbar (selection-toolbar.tsx: Cite, Side question, and
 * this): selecting tutor text shows ONE toolbar. It opens the same margin thread the floating button does.
 */
export function createAskAction({ onAsk }: { onAsk: (mark: AskMark) => void }): SelectionAction {
	const markOf = (): AskMark | null => {
		const sel = document.getSelection();
		if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
		return anchorFromSelection(document, sel.getRangeAt(0));
	};
	return {
		id: "ask",
		label: "Ask",
		ariaLabel: "Ask about this in the margin",
		icon: MessageSquareIcon,
		visible: () => markOf() !== null,
		onSelect: () => {
			const mark = markOf();
			if (!mark) return false;
			onAsk({ quote: mark.quote, anchor: mark.anchor });
			return true;
		},
	};
}

/** What is marked right now, or null: a non-empty selection inside one lesson passage. Pure of React state.
 *  `exclude` is a region the shared selection toolbar already serves (the transcript): the floating button stays out of it. */
export function currentMark(doc: Document, win: Window, exclude?: Element | null): Mark | null {
	const sel = doc.getSelection();
	if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	const node = range.commonAncestorContainer;
	const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
	if (!el || el.closest("textarea, input, [contenteditable='true']")) return null;
	if (exclude && exclude.contains(el)) return null;
	const found = anchorFromSelection(doc, range);
	if (!found) return null;
	const rect = range.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return null;
	// Touch: the platform's own selection toolbar sits ABOVE the selection, so the
	// button goes below it; with a mouse it goes above, out of the pointer's way.
	const coarse = win.matchMedia?.("(pointer: coarse)").matches ?? false;
	const below = coarse || rect.top < 48;
	return {
		quote: found.quote,
		anchor: found.anchor,
		x: Math.min(Math.max(rect.left + rect.width / 2, 72), win.innerWidth - 72),
		// below, on touch, the selection handles hang under the text: clear them
		y: below ? rect.bottom + (coarse ? 36 : 10) : rect.top - 42,
	};
}

export function AskSelection({ enabled, onAsk, exclude }: { enabled: boolean; onAsk: (mark: AskMark) => void; exclude?: Element | null }) {
	const [mark, setMark] = useState<Mark | null>(null);

	useEffect(() => {
		if (!enabled) {
			setMark(null);
			return;
		}
		let frame = 0;
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => setMark(currentMark(document, window, exclude)));
		};
		document.addEventListener("selectionchange", update);
		// the button is fixed to the viewport: follow the text while it scrolls
		window.addEventListener("scroll", update, { capture: true, passive: true });
		window.addEventListener("resize", update);
		update();
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("selectionchange", update);
			window.removeEventListener("scroll", update, { capture: true });
			window.removeEventListener("resize", update);
		};
	}, [enabled, exclude]);

	if (!enabled || !mark) return null;
	return (
		<button
			type="button"
			data-testid="ask-selection-button"
			// keep the selection alive through the press
			onPointerDown={(e) => e.preventDefault()}
			onMouseDown={(e) => e.preventDefault()}
			onClick={() => {
				onAsk({ quote: mark.quote, anchor: mark.anchor });
				document.getSelection()?.removeAllRanges();
				setMark(null);
			}}
			style={{ position: "fixed", left: mark.x, top: mark.y, transform: "translateX(-50%)" }}
			className="lh-touch z-50 inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-popover px-3 text-xs font-medium text-popover-foreground shadow-md transition-colors hover:bg-accent"
		>
			<MessageSquareIcon className="size-3.5" aria-hidden />
			Ask about this
		</button>
	);
}
