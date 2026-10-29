"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useSwipe } from "./use-swipe.ts";

/**
 * Swipe-right row actions (Android phone pass, owner 2026-10-28; mirrored from swipe-left on 2026-10-29): swiping a sidebar
 * row right slides it over and reveals its actions behind it, on the left (Rename, Delete). Only one row is open at a time (`openId` is owned by the list); a tap anywhere else
 * closes it. The actions are `div role="button"`, not `<button>`: the sidebar's keyboard walk indexes the row buttons
 * (`querySelectorAll("button")`), and a second button per row would break it.
 */

export interface RowAction {
	key: string;
	label: string;
	onPress: () => void;
	/** "danger" reads as destructive (it still only opens a confirmation; nothing is deleted by the swipe). */
	tone?: "default" | "danger";
}

/** The width of one revealed action. */
export const ACTION_WIDTH = 76;

/** Pure: where the row sits (px, 0 = closed, positive = slid right) for a finger offset from where it started. */
export function rowPosition(startedOpen: boolean, offset: number, revealWidth: number): number {
	const base = startedOpen ? revealWidth : 0;
	return Math.max(0, Math.min(revealWidth, base + offset));
}

/** Pure: does the row end up open? Past the halfway point, or a committed flick in the opening direction. */
export function endsOpen(startedOpen: boolean, offset: number, commit: boolean, revealWidth: number): boolean {
	if (commit) return offset > 0; // a flick right opens, a flick left closes
	return rowPosition(startedOpen, offset, revealWidth) >= revealWidth / 2;
}

export function SwipeRow({
	id,
	openId,
	onOpenChange,
	actions,
	children,
}: {
	id: string;
	/** The id of the row that is open in this list, if any. */
	openId: string | null;
	onOpenChange: (next: string | null) => void;
	actions: readonly RowAction[];
	children: ReactNode;
}) {
	const revealWidth = actions.length * ACTION_WIDTH;
	const open = openId === id;
	const [drag, setDrag] = useState<number | null>(null);
	const startedOpen = useRef(open);
	const containerRef = useRef<HTMLDivElement>(null);

	const slider = useSwipe<HTMLDivElement>(
		// "both": open it by swiping right, close an open one by swiping left
		{ axis: "x", way: "both", commitDistance: ACTION_WIDTH / 2, flickMinDistance: 20 },
		{
			onStart: () => {
				startedOpen.current = open;
				// opening a row closes the one that was open
				if (!open && openId !== null) onOpenChange(null);
			},
			onMove: (o) => setDrag(rowPosition(startedOpen.current, o, revealWidth)),
			onEnd: ({ commit, offset }) => {
				setDrag(null);
				const willOpen = endsOpen(startedOpen.current, offset, commit, revealWidth);
				onOpenChange(willOpen ? id : null);
			},
		},
		true,
	);

	// a touch anywhere outside an open row closes it (the same dismissal as the row menu)
	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) onOpenChange(null);
		};
		document.addEventListener("pointerdown", onDown, true);
		return () => document.removeEventListener("pointerdown", onDown, true);
	}, [open, onOpenChange]);

	const position = drag ?? (open ? revealWidth : 0);

	return (
		<div ref={containerRef} data-testid="swipe-row" data-swipe-row="" className="relative overflow-hidden rounded-lg">
			{/* The actions live in a strip exactly as wide as the row has slid, so nothing of them can show beside or under a closed
			    row (a swipe the other way moves nothing, and the strip stays zero wide); it follows the row back on release. */}
			<div
				className={cn("absolute inset-y-0 left-0 overflow-hidden", drag === null && "transition-[width] duration-200")}
				style={{ width: position }}
				aria-hidden={!open && drag === null}
			>
				<div className="flex h-full" style={{ width: revealWidth }}>
					{actions.map((a) => (
						<div
							key={a.key}
							role="button"
							tabIndex={open ? 0 : -1}
							data-testid={`swipe-action-${a.key}`}
							onClick={() => {
								onOpenChange(null);
								a.onPress();
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onOpenChange(null);
									a.onPress();
								}
							}}
							className={cn(
								"flex items-center justify-center text-xs font-medium",
								a.tone === "danger" ? "bg-red-600 text-white" : "bg-muted text-foreground",
							)}
							style={{ width: ACTION_WIDTH }}
						>
							{a.label}
						</div>
					))}
				</div>
			</div>
			<div
				ref={slider}
				className={cn("relative bg-background", drag === null && "transition-transform duration-200")}
				style={{ transform: position === 0 ? undefined : `translateX(${position}px)` }}
			>
				{children}
			</div>
		</div>
	);
}
