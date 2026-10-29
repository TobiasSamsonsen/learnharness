"use client";

import { useEffect, useRef, useState } from "react";
import { SKETCH_INK, sketchStrokeCut, sketchStrokeHit, sketchStrokePath, type SketchStroke } from "@/src/core";
import { DEFAULT_ERASER, DEFAULT_PEN, penStroke, type EraserSettings, type PenSettings } from "@/components/sketch/pen-settings";

/**
 * The web canvas (Android plan M1 + M3): a tall white page the learner
 * draws on with a pen, mouse or finger. Strokes are vector data — flat
 * [x, y, pressure] in PAGE CSS pixels (origin at the page's top-left,
 * y grows downward) — drawn as perfect-freehand outlines with the SAME
 * path function the server render uses (core/sketch.ts sketchStrokePath),
 * so what the learner sees is what the model sees.
 *
 * The page scrolls: a viewport-sized canvas sticks to the top of a
 * scroller and redraws under the scroll offset (a page-tall canvas would
 * blow browsers' canvas size limits). The page always has room below the
 * lowest ink, up to SKETCH_PAGE_MAX_HEIGHT.
 *
 * Pen-only once a pen is seen (palm rejection for stylus users): after the
 * first pen stroke, touch is ignored and pans the page natively. Without
 * a pen one finger draws and two fingers pan. A mouse scrolls with the
 * wheel. The eraser (the pen's eraser end or button, or the toolbar's)
 * either cuts the part of a stroke it passes over ("pixel") or removes
 * whole strokes ("stroke"); strokes already submitted (the kept page,
 * drawn dimmed) are locked.
 */

/** The default stroke diameter, CSS pixels (the pen's own is `pen.size`). */
export const SKETCH_PEN_SIZE = DEFAULT_PEN.size;
/** The eraser's default reach, CSS pixels. */
export const SKETCH_ERASER_RADIUS = 10;
/** The page never grows taller than this (the server's six pages of ≤ 2000 px). */
export const SKETCH_PAGE_MAX_HEIGHT = 12000;
/** Opacity of the kept (already submitted) strokes. */
const KEPT_ALPHA = 0.45;

/** The page's height: at least the viewport, and room below the lowest ink. */
export function sketchPageHeight(viewHeight: number, lowestY: number): number {
	return Math.min(SKETCH_PAGE_MAX_HEIGHT, Math.max(viewHeight, Math.ceil(lowestY + viewHeight * 0.6)));
}

export function lowestInk(strokes: readonly SketchStroke[]): number {
	let low = 0;
	for (const s of strokes) for (let k = 1; k < s.points.length; k += 3) low = Math.max(low, s.points[k]!);
	return low;
}

export type SketchTool = "pen" | "eraser";

/** The x, y of flat [x, y, pressure] triples, as flat [x, y, …]. */
function xyOf(points: readonly number[]): number[] {
	const out: number[] = [];
	for (let k = 0; k + 1 < points.length; k += 3) out.push(points[k]!, points[k + 1]!);
	return out;
}

export function SketchCanvas({
	strokes,
	kept = [],
	tool = "pen",
	brush = DEFAULT_PEN,
	eraser = DEFAULT_ERASER,
	onStroke,
	onErase,
	onCut,
}: {
	/** The unsent ink (editable). */
	strokes: readonly SketchStroke[];
	/** The kept page: submitted strokes, dimmed and locked. */
	kept?: readonly SketchStroke[];
	tool?: SketchTool;
	/** The pen's colour and width for the next stroke. */
	brush?: PenSettings;
	/** The eraser's mode and radius. */
	eraser?: EraserSettings;
	/** A finished stroke (pointer up). */
	onStroke: (stroke: SketchStroke) => void;
	/** One eraser gesture finished: indices into `strokes` it touched. */
	onErase?: (indices: number[]) => void;
	/** One pixel-eraser gesture finished: its path, flat [x, y, …] in page pixels. */
	onCut?: (path: number[]) => void;
}) {
	const scrollerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	// The gesture in progress. `rect` is read once at pointerdown (a layout
	// read per sample would stall a 240 Hz pen); `erase` collects hit indices.
	const live = useRef<{ pointerId: number; points: number[]; rect: DOMRect; erase: Set<number> | null } | null>(null);
	const frame = useRef<number | null>(null);
	const penSeen = useRef(false);
	const [pen, setPen] = useState(false);
	const scrollTop = useRef(0);
	const [viewHeight, setViewHeight] = useState(0);
	// Two-finger pan (touch without a pen): the fingers down, by pointer id.
	const touches = useRef(new Map<number, number>());
	const panning = useRef(false);
	// Path2D per finished stroke — redraws stay cheap on a busy page.
	const paths = useRef(new WeakMap<SketchStroke, Path2D>());
	const strokesRef = useRef(strokes);
	strokesRef.current = strokes;
	const keptRef = useRef(kept);
	keptRef.current = kept;
	const brushRef = useRef(brush);
	brushRef.current = brush;
	const eraserRef = useRef(eraser);
	eraserRef.current = eraser;

	const pathOf = (s: SketchStroke): Path2D => {
		let p = paths.current.get(s);
		if (!p) {
			p = new Path2D(sketchStrokePath(s));
			paths.current.set(s, p);
		}
		return p;
	};

	const draw = () => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.globalAlpha = 1;
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, -scrollTop.current * dpr);
		ctx.globalAlpha = KEPT_ALPHA;
		for (const s of keptRef.current) {
			ctx.fillStyle = s.color ?? SKETCH_INK;
			ctx.fill(pathOf(s));
		}
		const hits = live.current?.erase;
		// the pixel eraser shows its cut live: a touched stroke is drawn as its pieces
		const cutPath = live.current?.erase && eraserRef.current.mode === "pixel" ? xyOf(live.current.points) : null;
		strokesRef.current.forEach((s, i) => {
			const pieces = cutPath ? sketchStrokeCut(s, cutPath, eraserRef.current.radius) : null;
			// A stroke the stroke eraser is over fades until the gesture ends.
			// sent ink being edited (thawed, marked `fresh: false`) stays dimmed like the kept page
			ctx.globalAlpha = s.fresh === false ? KEPT_ALPHA : hits?.has(i) && !cutPath ? 0.2 : 1;
			ctx.fillStyle = s.color ?? SKETCH_INK;
			if (pieces) for (const piece of pieces) ctx.fill(new Path2D(sketchStrokePath(piece)));
			else ctx.fill(pathOf(s));
		});
		ctx.globalAlpha = 1;
		if (live.current && !live.current.erase && live.current.points.length >= 3) {
			const live_ = penStroke(brushRef.current, live.current.points);
			ctx.fillStyle = live_.color ?? SKETCH_INK;
			ctx.fill(new Path2D(sketchStrokePath(live_)));
		}
	};

	// Size the backing store to the viewport (and the screen's density).
	useEffect(() => {
		const scroller = scrollerRef.current;
		const canvas = canvasRef.current;
		if (!scroller || !canvas) return;
		const fit = () => {
			const dpr = window.devicePixelRatio || 1;
			const { width, height } = scroller.getBoundingClientRect();
			setViewHeight(Math.round(height));
			canvas.width = Math.max(1, Math.round(width * dpr));
			canvas.height = Math.max(1, Math.round(height * dpr));
			draw();
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(scroller);
		return () => observer.disconnect();
	}, []); // draw reads refs only

	useEffect(draw, [strokes, kept]);
	useEffect(() => () => {
		if (frame.current !== null) cancelAnimationFrame(frame.current);
	}, []);
	/** At most one redraw per frame while the pen moves or the page scrolls. */
	const drawSoon = () => {
		if (frame.current !== null) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = null;
			draw();
		});
	};

	const accepts = (e: React.PointerEvent) => {
		if (e.pointerType === "pen" && !penSeen.current) {
			penSeen.current = true;
			setPen(true);
		}
		return !(penSeen.current && e.pointerType === "touch");
	};

	const sample = (e: PointerEvent, rect: DOMRect, out: number[]) => {
		// Mice and fingers report no real pressure: a steady middle value.
		const pressure = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
		out.push(
			Math.round((e.clientX - rect.left) * 10) / 10,
			Math.round((e.clientY - rect.top + scrollTop.current) * 10) / 10,
			Math.round(pressure * 100) / 100,
		);
	};

	/** Mark the new strokes under the eraser's newest samples. */
	const eraseAt = (points: number[], from: number, hits: Set<number>) => {
		strokesRef.current.forEach((s, i) => {
			if (hits.has(i)) return;
			for (let k = from; k < points.length; k += 3) {
				if (sketchStrokeHit(s, points[k]!, points[k + 1]!, eraserRef.current.radius)) {
					hits.add(i);
					return;
				}
			}
		});
	};

	const pageHeight = sketchPageHeight(viewHeight, Math.max(lowestInk(kept), lowestInk(strokes)));

	return (
		<div
			ref={scrollerRef}
			data-testid="sketch-scroller"
			className="absolute inset-0 overflow-y-auto overscroll-contain"
			onScroll={(e) => {
				scrollTop.current = e.currentTarget.scrollTop;
				drawSoon();
			}}
		>
			<div style={{ height: pageHeight }}>
				<canvas
					ref={canvasRef}
					data-testid="sketch-canvas"
					data-tool={tool}
					// A pen seen → touch pans the page natively; before that the
					// canvas owns every gesture (two fingers pan by hand, below).
					style={{ touchAction: pen ? "pan-y" : "none", height: viewHeight || "100%" }}
					className={`sticky top-0 block w-full ${tool === "eraser" ? "cursor-cell" : "cursor-crosshair"}`}
					onPointerDown={(e) => {
						if (e.button !== 0 && e.button !== 5) return;
						if (!accepts(e)) return;
						e.preventDefault();
						e.currentTarget.setPointerCapture(e.pointerId);
						if (e.pointerType === "touch") {
							touches.current.set(e.pointerId, e.clientY);
							if (touches.current.size >= 2) {
								// A second finger: the stroke the first began is a pan.
								panning.current = true;
								if (live.current) {
									live.current = null;
									draw();
								}
								return;
							}
						}
						if (live.current || panning.current) return;
						const points: number[] = [];
						const rect = e.currentTarget.getBoundingClientRect();
						sample(e.nativeEvent, rect, points);
						// The toolbar's eraser, the pen's eraser end (button 5), or its
						// eraser button (buttons bit 32).
						const erase = tool === "eraser" || e.button === 5 || (e.buttons & 32) !== 0 ? new Set<number>() : null;
						live.current = { pointerId: e.pointerId, points, rect, erase };
						if (erase && eraserRef.current.mode === "stroke") eraseAt(points, 0, erase);
						draw();
					}}
					onPointerMove={(e) => {
						if (panning.current && touches.current.has(e.pointerId)) {
							const prev = touches.current.get(e.pointerId)!;
							touches.current.set(e.pointerId, e.clientY);
							// Two fingers move together: each contributes half.
							const scroller = scrollerRef.current;
							if (scroller) scroller.scrollTop -= (e.clientY - prev) / touches.current.size;
							return;
						}
						if (!live.current || live.current.pointerId !== e.pointerId) return;
						const native = e.nativeEvent;
						const events = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
						const from = live.current.points.length;
						for (const ev of events.length > 0 ? events : [native]) sample(ev, live.current.rect, live.current.points);
						if (live.current.erase && eraserRef.current.mode === "stroke") eraseAt(live.current.points, from, live.current.erase);
						drawSoon();
					}}
					onPointerUp={(e) => {
						touches.current.delete(e.pointerId);
						if (touches.current.size === 0) panning.current = false;
						if (!live.current || live.current.pointerId !== e.pointerId) return;
						const { points, erase } = live.current;
						live.current = null;
						if (erase) {
							if (eraserRef.current.mode === "pixel") onCut?.(xyOf(points));
							else if (erase.size > 0) onErase?.([...erase]);
							else draw();
						} else onStroke(penStroke(brushRef.current, points));
					}}
					onPointerCancel={(e) => {
						// The OS took the pointer (a palm, a gesture): drop the stroke.
						touches.current.delete(e.pointerId);
						if (touches.current.size === 0) panning.current = false;
						if (!live.current || live.current.pointerId !== e.pointerId) return;
						live.current = null;
						draw();
					}}
				/>
			</div>
		</div>
	);
}
