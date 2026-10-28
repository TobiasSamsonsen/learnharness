"use client";

import { useSwipe } from "./use-swipe.ts";

/**
 * The question and practice docks' grab handle (Android phone pass, owner 2026-10-28: swipe down to collapse a dock). A
 * thin row above the dock with a small pill, shown on touch devices only. Swiping it DOWN folds an open dock to its bar
 * (the same fold the transcript scroll does, but it stays folded: the caller remembers it was the learner's choice);
 * swiping it UP, or tapping it, opens a folded one. It sits outside the dock's scrolling body on purpose: a vertical
 * swipe in the body is a scroll.
 */
export function DockHandle({ expanded, onCollapse, onExpand }: { expanded: boolean; onCollapse: () => void; onExpand: () => void }) {
	const ref = useSwipe<HTMLDivElement>(
		{ axis: "y", way: expanded ? "pos" : "neg", commitDistance: 36, flickMinDistance: 16 },
		{
			onEnd: ({ commit }) => {
				if (!commit) return;
				if (expanded) onCollapse();
				else onExpand();
			},
		},
	);
	return (
		<div
			ref={ref}
			data-testid="dock-handle"
			role="button"
			tabIndex={-1}
			aria-label={expanded ? "Collapse" : "Expand"}
			onClick={() => (expanded ? onCollapse() : onExpand())}
			className="hidden h-5 w-full cursor-pointer items-center justify-center [@media(pointer:coarse)]:flex"
		>
			<div aria-hidden className="h-1 w-9 rounded-full bg-muted-foreground/35" />
		</div>
	);
}
