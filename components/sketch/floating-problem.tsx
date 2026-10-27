"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GripHorizontalIcon, MinusIcon, PenLineIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { repairMathForDisplay } from "@/src/core";

/**
 * The sketch view's floating problem box (owner, 2026-10-26): the canvas
 * fills the view, and the question floats above it — draggable by its
 * header, collapsible to a small pill (never a long bar) so the learner
 * has the whole page to work on. Position and collapsed state are
 * remembered between openings (localStorage, per browser).
 *
 * It must sit inside a `relative` parent: its coordinates are that
 * parent's, and the parent's size bounds the drag.
 */

const STORAGE_KEY = "lh:sketch-box";
/** Keep this much of the box inside the parent's edge. */
const EDGE = 4;
/** A press that moves less than this is a click, not a drag. */
const DRAG_SLOP = 4;

export interface BoxState {
	x: number;
	y: number;
	collapsed: boolean;
}

const DEFAULT_BOX: BoxState = { x: 12, y: 12, collapsed: false };

/** Pure: a position kept inside `bounds` for a box of `size`. A box
 *  larger than its bounds pins to the top-left edge. */
export function clampBoxPosition(
	x: number,
	y: number,
	size: { width: number; height: number },
	bounds: { width: number; height: number },
): { x: number; y: number } {
	const maxX = Math.max(EDGE, bounds.width - size.width - EDGE);
	const maxY = Math.max(EDGE, bounds.height - size.height - EDGE);
	return { x: Math.min(Math.max(x, EDGE), maxX), y: Math.min(Math.max(y, EDGE), maxY) };
}

function readBox(): BoxState {
	try {
		const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<BoxState> | null;
		if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && typeof v.collapsed === "boolean") {
			return { x: v.x as number, y: v.y as number, collapsed: v.collapsed };
		}
	} catch {
		// private window, blocked storage: the default box
	}
	return DEFAULT_BOX;
}

function writeBox(box: BoxState): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(box));
	} catch {
		// remembering is a convenience, never required
	}
}

export function FloatingProblem({
	label,
	statement,
	children,
}: {
	label: string;
	statement: string;
	/** The question's answer controls (MC options, confidence — M3), below
	 *  the statement and scrolling with it. */
	children?: React.ReactNode;
}) {
	const [box, setBox] = useState<BoxState>(readBox);
	const boxRef = useRef(box);
	const rootRef = useRef<HTMLDivElement>(null);
	const drag = useRef<{ pointerId: number; dx: number; dy: number; startX: number; startY: number } | null>(null);
	/** A drag just ended on the pill: its click must not expand it. */
	const dragged = useRef(false);

	const update = useCallback((next: BoxState, persist: boolean) => {
		boxRef.current = next;
		setBox(next);
		if (persist) writeBox(next);
	}, []);

	/** Pull the box back inside its parent (a resize, or a size change). */
	const clampIntoView = useCallback(() => {
		const root = rootRef.current;
		const parent = root?.parentElement;
		if (!root || !parent) return;
		const bounds = parent.getBoundingClientRect();
		if (bounds.width === 0 || bounds.height === 0) return; // not laid out (tests)
		const size = root.getBoundingClientRect();
		const current = boxRef.current;
		const pos = clampBoxPosition(current.x, current.y, size, bounds);
		if (pos.x !== current.x || pos.y !== current.y) update({ ...current, ...pos }, true);
	}, [update]);

	useEffect(() => {
		clampIntoView();
	}, [box.collapsed, clampIntoView]);
	useEffect(() => {
		window.addEventListener("resize", clampIntoView);
		return () => window.removeEventListener("resize", clampIntoView);
	}, [clampIntoView]);

	const dragProps = {
		onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
			if (e.button !== 0 || (e.target as HTMLElement).closest("[data-no-drag]")) return;
			const root = rootRef.current;
			if (!root) return;
			const rect = root.getBoundingClientRect();
			e.currentTarget.setPointerCapture?.(e.pointerId);
			drag.current = { pointerId: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top, startX: e.clientX, startY: e.clientY };
		},
		onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
			const d = drag.current;
			const root = rootRef.current;
			const parent = root?.parentElement;
			if (!d || d.pointerId !== e.pointerId || !root || !parent) return;
			if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_SLOP && !dragged.current) return;
			dragged.current = true;
			const bounds = parent.getBoundingClientRect();
			const pos = clampBoxPosition(e.clientX - bounds.left - d.dx, e.clientY - bounds.top - d.dy, root.getBoundingClientRect(), bounds);
			update({ ...boxRef.current, ...pos }, false);
		},
		onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
			if (!drag.current || drag.current.pointerId !== e.pointerId) return;
			drag.current = null;
			if (dragged.current) writeBox(boxRef.current);
		},
		onPointerCancel: (e: React.PointerEvent<HTMLElement>) => {
			if (drag.current?.pointerId === e.pointerId) drag.current = null;
		},
	};

	const toggle = (collapsed: boolean) => update({ ...boxRef.current, collapsed }, true);

	if (box.collapsed) {
		return (
			<div ref={rootRef} data-ink-hole className="absolute z-10" style={{ left: box.x, top: box.y }}>
				<button
					type="button"
					data-testid="sketch-problem-pill"
					aria-label={`Show the ${label.toLowerCase()}`}
					title={`Show the ${label.toLowerCase()} (drag to move)`}
					{...dragProps}
					onClick={() => {
						// The click that ends a drag is not an expand.
						if (dragged.current) {
							dragged.current = false;
							return;
						}
						toggle(false);
					}}
					className="flex cursor-grab touch-none items-center gap-1.5 rounded-full border bg-card py-1.5 pr-3 pl-2.5 text-xs font-medium tracking-wide text-muted-foreground uppercase shadow-lg transition-colors hover:text-foreground active:cursor-grabbing"
				>
					<PenLineIcon className="size-3.5" />
					{label}
				</button>
			</div>
		);
	}
	return (
		<div
			ref={rootRef}
			data-ink-hole
			data-testid="sketch-problem-box"
			className="absolute z-10 w-[min(34rem,calc(100%-1rem))] rounded-xl border bg-card shadow-lg"
			style={{ left: box.x, top: box.y }}
		>
			<div
				{...dragProps}
				onPointerUp={(e) => {
					dragProps.onPointerUp(e);
					dragged.current = false;
				}}
				className="flex cursor-grab touch-none items-center gap-1.5 px-2.5 pt-2 pb-1 select-none active:cursor-grabbing"
			>
				<GripHorizontalIcon className="size-3.5 text-muted-foreground/60" />
				<span className="flex-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
				<button
					type="button"
					data-no-drag
					data-testid="sketch-problem-collapse"
					aria-label={`Collapse the ${label.toLowerCase()}`}
					title="Collapse"
					onClick={() => toggle(true)}
					className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				>
					<MinusIcon className="size-4" />
				</button>
			</div>
			<div className="lh-prose max-h-[45vh] overflow-y-auto px-3 pb-3 text-[15px]">
				<MessageResponse>{repairMathForDisplay(statement)}</MessageResponse>
				{children}
			</div>
		</div>
	);
}
