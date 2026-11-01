"use client";

import { useEffect, useState } from "react";
import { MessageSquareIcon } from "lucide-react";
import { ASK_SCOPE_SELECTOR, markedQuote } from "@/components/clarify-core";

/**
 * The floating "Ask" button (owner design, 2026-11-01): while a quiz question is
 * pending, marking text in the learning text (or in the question itself) offers
 * an "Ask about this" button beside the selection; pressing it hands the marked
 * text to the dock's Ask area. It never takes focus or collapses the selection
 * (pointerdown is prevented), so native copy and the touch handles keep working.
 */

interface Mark {
	quote: string;
	/** Viewport coordinates of the button's anchor (the selection's edge). */
	x: number;
	y: number;
}

/** What is marked right now, or null: a non-empty selection inside one scope
 *  ([data-session-find-root]), not inside a field. Pure of React state. */
export function currentMark(doc: Document, win: Window): Mark | null {
	const sel = doc.getSelection();
	if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	const node = range.commonAncestorContainer;
	const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
	if (!el || !el.closest(ASK_SCOPE_SELECTOR)) return null;
	if (el.closest("textarea, input, [contenteditable='true']")) return null;
	const quote = markedQuote(sel.toString());
	if (!quote) return null;
	const rect = range.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return null;
	// Touch: the platform's own selection toolbar sits ABOVE the selection, so the
	// button goes below it; with a mouse it goes above, out of the pointer's way.
	const coarse = win.matchMedia?.("(pointer: coarse)").matches ?? false;
	const below = coarse || rect.top < 48;
	return {
		quote,
		x: Math.min(Math.max(rect.left + rect.width / 2, 72), win.innerWidth - 72),
		y: below ? rect.bottom + 10 : rect.top - 42,
	};
}

export function AskSelection({ enabled, onAsk }: { enabled: boolean; onAsk: (quote: string) => void }) {
	const [mark, setMark] = useState<Mark | null>(null);

	useEffect(() => {
		if (!enabled) {
			setMark(null);
			return;
		}
		let frame = 0;
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => setMark(currentMark(document, window)));
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
	}, [enabled]);

	if (!enabled || !mark) return null;
	return (
		<button
			type="button"
			data-testid="ask-selection-button"
			// keep the selection alive through the press
			onPointerDown={(e) => e.preventDefault()}
			onMouseDown={(e) => e.preventDefault()}
			onClick={() => {
				onAsk(mark.quote);
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
