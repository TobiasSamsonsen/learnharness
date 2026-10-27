"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ExpandIcon, MaximizeIcon, MinusIcon, PlusIcon, ShrinkIcon } from "lucide-react";
import type { PlanNodeStatus } from "@/src/core";
import { blockLayout, GRAPH_PAD, NODE_H, NODE_W_MIN, PlanDiagram, type LayoutNode } from "@/components/plan-block";
import { FIT_PAD, fitGraphView, fitZoomFor, zoomedGraphView, type Viewport } from "@/components/pan-zoom";
import { usePanZoomGestures } from "@/components/use-pan-zoom-gestures";
import { cn } from "@/lib/utils";
import { useBackLayer } from "./back-layers.ts";

/**
 * The course's skill map (owner, 2026-10-25 — "way too large for the size
 * it displays at"): a 32-skill curriculum lays out ~1800 units wide, and
 * scaled into the page column its text shrank to ~5px. The map now sits in
 * a pan/zoom viewport that OPENS READABLE — at READABLE_ZOOM, centered on
 * the skills that are next up or due (where the learner is) — and shrinks
 * to the map when the whole of it is readable anyway. Drag pans; Ctrl/⌘ +
 * wheel (or a trackpad pinch) zooms, so a plain wheel keeps scrolling the
 * page; the buttons zoom, fit, and expand the map to the whole window
 * (Esc or the button returns), where the plain wheel zooms. Same fit-floor
 * math as the plan popup (components/pan-zoom.ts).
 */

/** The opening zoom: text-xs at 0.9 ≈ 11px — readable, not oversized. */
export const READABLE_ZOOM = 0.9;
/** The inline viewport's height ceiling. */
export const MAP_MAX_H = 440;

const PAD = GRAPH_PAD;

/** The inline viewport's height for a padded map box at this width: the
 *  map's own height at the zoom it opens with, capped. Pure. */
export function mapViewportHeight(box: { w: number; h: number }, width: number): number {
	if (!box.w || !width) return MAP_MAX_H;
	const zoom = Math.min(1, Math.max(READABLE_ZOOM, (width - FIT_PAD) / box.w));
	return Math.min(MAP_MAX_H, Math.ceil(box.h * zoom + FIT_PAD));
}

/** The zoom floor: the fit, but never past 1:1 — a small map shows at its
 *  natural size instead of blowing up. Pure. */
export function mapFloor(box: { w: number; h: number }, viewport: { w: number; h: number }): number {
	return Math.min(fitZoomFor(box, viewport), 1);
}

/** The opening view: the whole map when it is readable at the floor;
 *  otherwise READABLE_ZOOM, centered on `focus` (map coordinates) and
 *  clamped so no empty margin shows past the map's edges. Pure. */
export function initialMapView(
	box: { w: number; h: number },
	viewport: { w: number; h: number },
	focus: { x: number; y: number } | null,
): Viewport {
	const floor = mapFloor(box, viewport);
	if (floor >= READABLE_ZOOM) return fitGraphView(box, viewport, floor);
	const zoom = READABLE_ZOOM;
	const axis = (size: number, extent: number, at: number) => {
		const scaled = extent * zoom;
		if (scaled <= size) return (size - scaled) / 2;
		return Math.min(0, Math.max(size - scaled, size / 2 - at * zoom));
	};
	const f = focus ?? { x: box.w / 2, y: 0 };
	return { zoom, x: axis(viewport.w, box.w, f.x), y: axis(viewport.h, box.h, f.y) };
}

export function SkillMap({
	nodes,
	edges,
	statusOf,
	focusIds,
}: {
	nodes: readonly LayoutNode[];
	edges: ReadonlyArray<{ from: string; to: string }>;
	statusOf: (id: string) => PlanNodeStatus;
	/** Where the map opens: the skills next up / due. */
	focusIds: readonly string[];
}) {
	const markerId = useId().replace(/[^a-zA-Z0-9-]/g, "");
	const layout = useMemo(() => blockLayout(nodes, edges), [nodes, edges]);
	const box = useMemo(() => ({ w: layout.width + 2 * PAD, h: layout.height + 2 * PAD }), [layout]);
	// The focus nodes' bounding-box center, in the padded map's coordinates.
	const focus = useMemo(() => {
		const ids = focusIds.filter((id) => layout.x.has(id));
		if (ids.length === 0) return null;
		const ox = layout.originX ?? 0;
		const oy = layout.originY ?? 0;
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const id of ids) {
			const x = layout.x.get(id)! - ox + PAD;
			const y = layout.y.get(id)! - oy + PAD;
			x0 = Math.min(x0, x);
			y0 = Math.min(y0, y);
			x1 = Math.max(x1, x + (layout.nodeW.get(id) ?? NODE_W_MIN));
			y1 = Math.max(y1, y + (layout.nodeH.get(id) ?? NODE_H));
		}
		return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
	}, [focusIds, layout]);

	const [expanded, setExpanded] = useState(false);
	const viewportRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });
	useEffect(() => {
		const el = viewportRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const floor = useMemo(() => mapFloor(box, size), [box, size]);
	const [view, setView] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
	const [settled, setSettled] = useState(false);
	const userAdjustedRef = useRef(false);
	const atFloor = view.zoom <= floor + 1e-9;

	// (Re)open at the readable focus view — on mount, on a resize, and on
	// expanding / collapsing — until the learner moves the map themselves.
	useEffect(() => {
		userAdjustedRef.current = false;
	}, [expanded]);
	useEffect(() => {
		if (userAdjustedRef.current || !size.w || !size.h) return;
		setView(initialMapView(box, size, focus));
		const raf = requestAnimationFrame(() => setSettled(true));
		return () => cancelAnimationFrame(raf);
	}, [box, size, focus, expanded]);

	useEffect(() => {
		const el = viewportRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			// Inline, a plain wheel scrolls the page; Ctrl/⌘ (and a trackpad
			// pinch, which arrives as ctrl+wheel) zooms. Expanded, it zooms.
			if (!expanded && !e.ctrlKey && !e.metaKey) return;
			e.preventDefault();
			const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
			const rect = el.getBoundingClientRect();
			setView((v) => zoomedGraphView(v, Math.exp(-dy * 0.0015), floor, { x: e.clientX - rect.left, y: e.clientY - rect.top }, box, size));
			userAdjustedRef.current = true;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [expanded, floor, box, size]);

	useEffect(() => {
		if (!expanded) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setExpanded(false);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [expanded]);
	// Android back collapses the expanded map too (same as Esc).
	useBackLayer(expanded, () => setExpanded(false));

	// Mouse drags; touch pans and pinches. Inline, one finger is the page's
	// scroll and two fingers are the map's (the Ctrl+wheel analogue).
	const { panning, handlers } = usePanZoomGestures({
		viewportRef,
		view,
		setView,
		surface: { floor, box, viewport: size },
		onAdjusted: () => {
			userAdjustedRef.current = true;
		},
		touchPanNeedsTwo: !expanded,
	});
	const stepZoom = (factor: number) => {
		userAdjustedRef.current = true;
		setView((v) => zoomedGraphView(v, factor, floor, { x: size.w / 2, y: size.h / 2 }, box, size));
	};
	const fit = () => {
		userAdjustedRef.current = true;
		if (size.w && size.h) setView(fitGraphView(box, size, floor));
	};

	const inlineHeight = mapViewportHeight(box, size.w);
	const control =
		"pointer-events-auto flex size-7 items-center justify-center rounded-md border border-border/70 bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:bg-accent hover:text-foreground";

	return (
		<div
			data-testid="skill-map"
			data-expanded={expanded}
			className={cn(
				expanded && "lh-no-drag fixed inset-x-0 bottom-0 top-13 z-40 flex flex-col bg-background/95 p-4 pb-[calc(1rem+var(--lh-safe-bottom))] backdrop-blur-sm",
			)}
		>
			<div
				ref={viewportRef}
				data-testid="skill-map-viewport"
				className={cn(
					"relative overflow-hidden rounded-xl border border-border/60 select-none",
					// Inline, one finger scrolls the page (pan-y); expanded, the map owns every touch.
					expanded ? "min-h-0 flex-1 touch-none" : "touch-pan-y",
					atFloor ? "cursor-default" : panning ? "cursor-grabbing" : "cursor-grab",
				)}
				style={expanded ? undefined : { height: inlineHeight }}
				{...handlers}
			>
				<div
					className="absolute top-0 left-0 origin-top-left"
					style={{
						transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
						opacity: settled ? 1 : 0,
						transition: panning || !settled ? "none" : "transform 180ms ease-out, opacity 160ms ease-out",
					}}
				>
					<PlanDiagram nodes={nodes} edges={edges} statusOf={statusOf} markerId={markerId} pad={PAD} naturalSize />
				</div>
				<div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-2">
					<span className="truncate text-[11px] text-muted-foreground/60">
						<span className="[@media(hover:none)]:hidden">
							{atFloor ? "Zoom in to pan" : expanded ? "Drag to pan · scroll to zoom" : "Drag to pan · Ctrl+scroll to zoom"}
						</span>
						<span className="hidden [@media(hover:none)]:inline">
							{expanded ? "Drag to pan · pinch to zoom" : "Two fingers to pan and pinch"}
						</span>
					</span>
					<div className="flex shrink-0 gap-1">
						<button type="button" aria-label="Zoom out" className={control} onClick={() => stepZoom(1 / 1.25)}>
							<MinusIcon className="size-3.5" />
						</button>
						<button type="button" aria-label="Fit the whole map" data-testid="skill-map-fit" className={control} onClick={fit}>
							<MaximizeIcon className="size-3.5" />
						</button>
						<button type="button" aria-label="Zoom in" className={control} onClick={() => stepZoom(1.25)}>
							<PlusIcon className="size-3.5" />
						</button>
						<button
							type="button"
							aria-label={expanded ? "Back to the page" : "Expand the map"}
							data-testid="skill-map-expand"
							className={control}
							onClick={() => setExpanded((x) => !x)}
						>
							{expanded ? <ShrinkIcon className="size-3.5" /> : <ExpandIcon className="size-3.5" />}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
