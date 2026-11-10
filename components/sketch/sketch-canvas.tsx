"use client";

import { useEffect, useRef, useState } from "react";
import { SKETCH_INK, sketchStrokeHit, sketchStrokePath, type SketchStroke } from "@/src/core";
import { advanceCut, isAppend, layerBlit, layerGeometry, layerWorldRect, newCut, sameSet, sameStrokes, sameView, strokeVisible, xyOf, type CutState, type LayerGeometry, type Rect } from "@/components/sketch/ink-layer";
import { DEFAULT_ERASER, DEFAULT_PEN, penStroke, type EraserSettings, type PenSettings } from "@/components/sketch/pen-settings";
import { backgroundColor, backgroundLines, PAPER_SIZES, DEFAULT_PAPER_SIZE, type SketchBackground } from "@/components/sketch/sketch-background";
import { displayInk, SHEET_COLOR, type SheetTone } from "@/components/sketch/sketch-sheet";
import { ZoomIndicator } from "@/components/sketch/zoom-indicator";
import { notePenNear } from "@/components/sketch/palm-guard";
import { PinchTracker } from "@/components/sketch/pinch-gate";
import { liftTap, moveTap, startTap, type TapTracker } from "@/components/sketch/tap-gesture";
import { dist, HOLD_MS, isHeld, linePoints, MIN_LINE_PX, snapAngle } from "@/components/sketch/straight-line";
import { lineAngle, straightSegments, type Segment } from "@/components/sketch/line-angle";
import { paintAngleGuide } from "@/components/sketch/angle-guide";
import { eraserWorldRadius, fitInk, HOME_VIEW, panBy, penWorldSize, pinchStep, thinPath, toScreen, toWorld, zoomAbout, type SketchView } from "@/components/sketch/view-transform";

/**
 * The web canvas (Android plan M1 + M3, infinite since M13c): an unbounded
 * white plane the learner draws on with a pen, mouse or finger. Strokes are
 * vector data — flat [x, y, pressure] in WORLD pixels (any origin, negatives
 * included; zoom 1 = one CSS pixel) — drawn as perfect-freehand outlines with
 * the SAME path function the server render uses (core/sketch.ts
 * sketchStrokePath), so what the learner sees is what the model sees (the
 * server then normalises the size to the writing, glyph-adaptive).
 *
 * The view (components/sketch/view-transform.ts) says which part of the plane
 * the canvas shows. The pen has a width on the PAGE (world units), nearly fixed
 * (90% at the top zoom, for subscripts), so zoomed in it looks fatter and the
 * learner keeps writing at about one size.
 *
 * Input (owner, M13c; modelled on how note apps do it — GoodNotes and
 * Samsung Notes' zoom lock): a pen draws. Once a pen has been seen, one
 * finger does nothing and a touch is ignored while the pen is down or has
 * just been near (a resting palm); two fingers pan and pinch to zoom. Without
 * a pen one finger draws and two fingers pan and zoom. A mouse: left draws,
 * the middle button drags the page, the wheel pans, Ctrl+wheel (or a
 * trackpad pinch) zooms. The eraser (the pen's eraser end or button, or the
 * toolbar's) either cuts the part of a stroke it passes over ("pixel") or
 * removes whole strokes ("stroke"); strokes already submitted (the kept page,
 * drawn dimmed) are locked until the eraser first touches them (see
 * ink-memory thawInk).
 */

/** The default stroke diameter, CSS pixels (the pen's own is `pen.size`). */
export const SKETCH_PEN_SIZE = DEFAULT_PEN.size;
/** The eraser's default reach, CSS pixels. */
export const SKETCH_ERASER_RADIUS = 10;
/** The native (Android shell) page still scrolls and never grows taller than this. */
export const SKETCH_PAGE_MAX_HEIGHT = 12000;
/** Opacity of the kept (already submitted) strokes. */
const KEPT_ALPHA = 0.45;
/** A touch this soon after the pen was last near is a palm, not a finger. */
const PALM_MS = 600;

/** The native page's height: at least the viewport, and room below the lowest ink. */
export function sketchPageHeight(viewHeight: number, lowestY: number): number {
	return Math.min(SKETCH_PAGE_MAX_HEIGHT, Math.max(viewHeight, Math.ceil(lowestY + viewHeight * 0.6)));
}

export function lowestInk(strokes: readonly SketchStroke[]): number {
	let low = 0;
	for (const s of strokes) for (let k = 1; k < s.points.length; k += 3) low = Math.max(low, s.points[k]!);
	return low;
}

export type SketchTool = "pen" | "eraser";

/** A stable "no kept page": a fresh `[]` default per render would look like new ink to the draw effect. */
const NO_STROKES: readonly SketchStroke[] = [];
/** The layer's context transform: world to its bitmap, for a layer drawn at view `v`. */
function layerTransform(v: SketchView, g: LayerGeometry): [number, number, number, number, number, number] {
	return [g.scale * v.zoom, 0, 0, g.scale * v.zoom, g.scale * (g.mx - v.x * v.zoom), g.scale * (g.my - v.y * v.zoom)];
}
/** How long after the view last moved the ink layer is rasterised again, sharp. */
const SETTLE_MS = 140;

/** The cached bitmap of the committed ink (see ink-layer.ts): what it holds, and the view it was drawn at. */
interface InkLayer {
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	geo: LayerGeometry;
	view: SketchView;
	dpr: number;
	tone: SheetTone;
	strokes: readonly SketchStroke[];
	kept: readonly SketchStroke[];
	/** Strokes left out of the bitmap: the eraser is showing them dimmed or in pieces. */
	excluded: ReadonlySet<SketchStroke>;
}

export function SketchCanvas({
	strokes,
	kept = NO_STROKES,
	tool = "pen",
	brush = DEFAULT_PEN,
	eraser = DEFAULT_ERASER,
	background = "none",
	tone = "light",
	paperSize = DEFAULT_PAPER_SIZE,
	onStroke,
	onErase,
	onCut,
	onTwoFingerTap,
	}: {
	/** The unsent ink (editable). */
	strokes: readonly SketchStroke[];
	/** The kept page: submitted strokes, dimmed and locked. */
	kept?: readonly SketchStroke[];
	tool?: SketchTool;
	/** The pen's colour and width (on screen) for the next stroke. */
	brush?: PenSettings;
	/** The eraser's mode and radius (on screen). */
	eraser?: EraserSettings;
	/** The paper under the ink (a drawing aid; never sent). */
	background?: SketchBackground;
	/** The sheet's tone: a dark sheet shows ink in lighter variants (display only). */
	tone?: SheetTone;
	/** The paper's spacing step (an index into PAPER_SIZES). */
	paperSize?: number;
	/** A finished stroke (pointer up), its width already in world units. */
	onStroke: (stroke: SketchStroke) => void;
	/** One eraser gesture finished: indices into `strokes` it touched. */
	onErase?: (indices: number[]) => void;
	/** One pixel-eraser gesture finished: its path (flat [x, y, …], world) and the eraser's radius in world units. */
	onCut?: (path: number[], radius: number) => void;
	/** Two fingers tapped together (M16b): undo, as in the note apps. */
	onTwoFingerTap?: () => void;
	}) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	// The gesture in progress. `erase` collects hit indices; `size` and `radius` are fixed at pointerdown, in
	// world units, so a zoom mid-stroke cannot change them.
	// `cut` is the pixel eraser's progress (what is left of each stroke it touched, and those pieces as paths).
	const live = useRef<{ pointerId: number; pointerType: string; points: number[]; erase: Set<number> | null; size: number; radius: number; straight: boolean; cut: { state: CutState; paths: Map<SketchStroke, { alpha: number; paths: Path2D[] }> } | null } | null>(null);
	// the cached ink layer, whether the view has moved since it was drawn (settle), and the timer that redraws it sharp
	const layer = useRef<InkLayer | null>(null);
	const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const forceLayer = useRef(false);
	// Hold to straighten (M16c): where the pen has been (screen px, with times) and the timer that checks it stayed put
	const holdSamples = useRef<{ x: number; y: number; t: number }[]>([]);
	const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	// The straight lines already on the page, taken once when the hold fires: the angle guide measures against them
	const angleSegments = useRef<Segment[]>([]);
	const frame = useRef<number | null>(null);
	const penSeen = useRef(false);
	const penNearAt = useRef(0);
	// a hovering pen (S Pen): where, on screen, so the brush or eraser can be previewed under it
	const hover = useRef<{ x: number; y: number } | null>(null);
	const view = useRef<SketchView>(HOME_VIEW);
	const rect = useRef({ left: 0, top: 0, width: 0, height: 0 });
	const fitted = useRef(false);
	const [zoomPct, setZoomPct] = useState(100);
	// Touch: the fingers down (canvas-relative), and the pinch they make.
	const [gate] = useState(() => new PinchTracker());
	const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
	const tap = useRef<TapTracker | null>(null);
	// Space held: the next drag pans (a mouse or a pen), as in the note apps
	const spaceDown = useRef(false);
	const onTwoFingerTapRef = useRef(onTwoFingerTap);
	onTwoFingerTapRef.current = onTwoFingerTap;
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
	const toolRef = useRef(tool);
	toolRef.current = tool;
	const backgroundRef = useRef(background);
	backgroundRef.current = background;
	const toneRef = useRef(tone);
	toneRef.current = tone;
	const paperSizeRef = useRef(paperSize);
	paperSizeRef.current = paperSize;

	const pathOf = (s: SketchStroke): Path2D => {
		let p = paths.current.get(s);
		if (!p) {
			p = new Path2D(sketchStrokePath(s));
			paths.current.set(s, p);
		}
		return p;
	};

	const paintStroke = (ctx: CanvasRenderingContext2D, s: SketchStroke, alpha: number, tone: SheetTone) => {
		ctx.globalAlpha = alpha;
		ctx.fillStyle = displayInk(s.color, tone);
		ctx.fill(pathOf(s));
	};

	/** The kept page, then the working ink, those meeting `rect` (world) and not `skip`. */
	const paintInk = (ctx: CanvasRenderingContext2D, working: readonly SketchStroke[], keptStrokes: readonly SketchStroke[], skip: ReadonlySet<SketchStroke>, rect: Rect, tone: SheetTone) => {
		for (const s of keptStrokes) if (!skip.has(s) && strokeVisible(s, rect)) paintStroke(ctx, s, KEPT_ALPHA, tone);
		// sent ink being edited (thawed, marked `fresh: false`) stays dimmed like the kept page
		for (const s of working) if (!skip.has(s) && strokeVisible(s, rect)) paintStroke(ctx, s, s.fresh === false ? KEPT_ALPHA : 1, tone);
		ctx.globalAlpha = 1;
	};

	/** Draw the committed ink into the (reused) offscreen layer at `v`; null when there is no second canvas to draw in. */
	const rasterLayer = (canvas: HTMLCanvasElement, dpr: number, geo: LayerGeometry, v: SketchView, tone: SheetTone, working: readonly SketchStroke[], keptStrokes: readonly SketchStroke[], excluded: ReadonlySet<SketchStroke>): InkLayer | null => {
		const el = layer.current?.canvas ?? document.createElement("canvas");
		if (el.width !== geo.width || el.height !== geo.height) {
			el.width = geo.width;
			el.height = geo.height;
		}
		const ctx = el.getContext("2d");
		if (!ctx) return null;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, el.width, el.height);
		ctx.setTransform(...layerTransform(v, geo));
		paintInk(ctx, working, keptStrokes, excluded, layerWorldRect(v, geo), tone);
		return { canvas: el, ctx, geo, view: v, dpr, tone, strokes: working, kept: keptStrokes, excluded };
	};

	const draw = () => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		const dpr = window.devicePixelRatio || 1;
		const v = view.current;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.globalAlpha = 1;
		const tone = toneRef.current;
		ctx.fillStyle = SHEET_COLOR[tone];
		ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
		const paper = backgroundRef.current;
		if (paper !== "none") {
			// the paper is drawn in screen space (crisp at any zoom) and follows the view
			const { xs, ys } = backgroundLines(paper, v, canvas.width / dpr, canvas.height / dpr, PAPER_SIZES[paperSizeRef.current] ?? 1);
			ctx.strokeStyle = backgroundColor(tone);
			ctx.fillStyle = backgroundColor(tone);
			ctx.lineWidth = 1;
			if (paper === "dots") {
				for (const x of xs) for (const y of ys) ctx.fillRect(x - 1, y - 1, 2, 2);
			} else {
				ctx.beginPath();
				for (const x of xs) (ctx.moveTo(x + 0.5, 0), ctx.lineTo(x + 0.5, canvas.height / dpr));
				for (const y of ys) (ctx.moveTo(0, y + 0.5), ctx.lineTo(canvas.width / dpr, y + 0.5));
				ctx.stroke();
			}
		}
		const working = strokesRef.current;
		const keptStrokes = keptRef.current;
		const l = live.current;
		// What the eraser is showing live — a stroke dimmed (stroke eraser) or in pieces (pixel eraser) — is left out of
		// the cached layer and drawn on top. The sent page (dimmed, locked) is reachable too: its strokes are numbered
		// after the working ones.
		const excluded = new Set<SketchStroke>();
		const pixel = !!l?.erase && eraserRef.current.mode === "pixel";
		if (l?.erase) {
			if (pixel) {
				l.cut ??= { state: newCut(), paths: new Map() };
				for (const s of advanceCut(l.cut.state, l.points, l.radius, [keptStrokes, working])) {
					l.cut.paths.set(s, { alpha: s.fresh === false || keptStrokes.includes(s) ? KEPT_ALPHA : 1, paths: (l.cut.state.pieces.get(s) ?? []).map((p) => new Path2D(sketchStrokePath(p))) });
				}
				for (const s of l.cut.paths.keys()) excluded.add(s);
			} else {
				for (const i of l.erase) {
					const s = i < working.length ? working[i] : keptStrokes[i - working.length];
					if (s) excluded.add(s);
				}
			}
		}
		// the committed ink: the cached layer, drawn again only when its content changed (or the view settled)
		const force = forceLayer.current;
		forceLayer.current = false;
		const geo = layerGeometry(canvas.width / dpr, canvas.height / dpr, dpr);
		let layerNow = layer.current;
		if (layerNow && !force && layerNow.dpr === dpr && layerNow.geo.width === geo.width && layerNow.geo.height === geo.height && layerNow.tone === tone && sameStrokes(layerNow.kept, keptStrokes) && sameSet(layerNow.excluded, excluded)) {
			if (!sameStrokes(layerNow.strokes, working)) {
				if (isAppend(layerNow.strokes, working)) {
					// one stroke more (a pen lifted): paint it onto the layer instead of drawing the page again
					const added = working[working.length - 1]!;
					layerNow.ctx.setTransform(...layerTransform(layerNow.view, layerNow.geo));
					if (!excluded.has(added) && strokeVisible(added, layerWorldRect(layerNow.view, layerNow.geo))) paintStroke(layerNow.ctx, added, added.fresh === false ? KEPT_ALPHA : 1, tone);
					layerNow.strokes = working;
				} else layerNow = null;
			}
		} else layerNow = null;
		layerNow ??= rasterLayer(canvas, dpr, geo, v, tone, working, keptStrokes, excluded);
		layer.current = layerNow;
		if (layerNow) {
			const b = layerBlit(layerNow.view, v, layerNow.geo);
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.globalAlpha = 1;
			ctx.drawImage(layerNow.canvas, Math.round(b.x * dpr), Math.round(b.y * dpr), Math.round(b.w * dpr), Math.round(b.h * dpr));
		}
		ctx.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, -v.x * v.zoom * dpr, -v.y * v.zoom * dpr);
		if (!layerNow) {
			// no second canvas to cache in: draw the visible strokes straight onto this one
			const rect: Rect = { minX: v.x, minY: v.y, maxX: v.x + canvas.width / dpr / v.zoom, maxY: v.y + canvas.height / dpr / v.zoom };
			paintInk(ctx, working, keptStrokes, excluded, rect, tone);
		}
		// the eraser's live view of what it touches: the strokes it is over fade, the pixel eraser's pieces show
		if (l?.erase) {
			if (pixel && l.cut) {
				for (const [s, { alpha, paths }] of l.cut.paths) {
					ctx.globalAlpha = alpha;
					ctx.fillStyle = displayInk(s.color, tone);
					for (const p of paths) ctx.fill(p);
				}
			} else {
				ctx.globalAlpha = 0.2;
				for (const s of excluded) {
					ctx.fillStyle = displayInk(s.color, tone);
					ctx.fill(pathOf(s));
				}
			}
		}
		ctx.globalAlpha = 1;
		if (l && !l.erase && l.points.length >= 3) {
			const inkNow = penStroke({ color: brushRef.current.color, size: l.size }, l.points);
			ctx.fillStyle = displayInk(inkNow.color, tone);
			ctx.fill(new Path2D(sketchStrokePath(inkNow)));
			// a held line drawn from near another straight line shows the angle between them until the pen lifts
			if (l.straight) {
				const start = { x: l.points[0]!, y: l.points[1]! };
				const end = { x: l.points[l.points.length - 3]!, y: l.points[l.points.length - 2]! };
				const guide = lineAngle(start, end, angleSegments.current, v.zoom);
				if (guide) {
					ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
					paintAngleGuide(ctx, guide, toScreen(v, guide.vertex.x, guide.vertex.y), displayInk(inkNow.color, tone));
				}
			}
		}
		// the hover preview, in screen space: the eraser's reach (the pen has none: the OS already shows its own)
		if (hover.current && !l && toolRef.current === "eraser") {
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.beginPath();
			ctx.arc(hover.current.x, hover.current.y, eraserRef.current.radius, 0, Math.PI * 2);
			ctx.lineWidth = 1;
			ctx.strokeStyle = "#64748b";
			ctx.stroke();
		}
	};

	/** At most one redraw per frame while the pen moves or the view changes. */
	const drawSoon = () => {
		if (frame.current !== null) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = null;
			draw();
		});
	};

	/** The view stopped moving: draw the ink layer again at it, sharp, if it was drawn at another. */
	const settle = () => {
		settleTimer.current = undefined;
		if (layer.current && sameView(layer.current.view, view.current)) return;
		forceLayer.current = true;
		draw();
	};

	const setView = (next: SketchView) => {
		view.current = next;
		setZoomPct(Math.round(next.zoom * 100));
		drawSoon();
		clearTimeout(settleTimer.current);
		settleTimer.current = setTimeout(settle, SETTLE_MS);
	};

	// Size the backing store to the viewport (and the screen's density); open on the ink the first time.
	useEffect(() => {
		const wrap = wrapRef.current;
		const canvas = canvasRef.current;
		if (!wrap || !canvas) return;
		const fit = () => {
			const dpr = window.devicePixelRatio || 1;
			const r = wrap.getBoundingClientRect();
			rect.current = { left: r.left, top: r.top, width: r.width, height: r.height };
			canvas.width = Math.max(1, Math.round(r.width * dpr));
			canvas.height = Math.max(1, Math.round(r.height * dpr));
			if (!fitted.current && r.width > 0 && r.height > 0) {
				fitted.current = true;
				view.current = fitInk([...keptRef.current, ...strokesRef.current].map((s) => s.points), r.width, r.height);
				setZoomPct(Math.round(view.current.zoom * 100));
			}
			draw();
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(wrap);
		return () => observer.disconnect();
	}, []); // draw reads refs only

	// Holding Space turns a mouse or pen drag into a pan (M16a); not while a field or button has the key
	useEffect(() => {
	const skip = (t: EventTarget | null) => {
	const el = t as HTMLElement | null;
	return !!el && (el.isContentEditable === true || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName));
	};
	const set = (on: boolean) => {
	spaceDown.current = on;
	if (canvasRef.current) canvasRef.current.style.cursor = on ? "grab" : "";
	};
	const down = (e: KeyboardEvent) => {
	if (e.code !== "Space" || e.ctrlKey || e.metaKey || e.altKey || skip(e.target)) return;
	e.preventDefault();
	set(true);
	};
	const up = (e: KeyboardEvent) => {
	if (e.code === "Space") set(false);
	};
	const blur = () => set(false);
	window.addEventListener("keydown", down);
	window.addEventListener("keyup", up);
	window.addEventListener("blur", blur);
	return () => {
	window.removeEventListener("keydown", down);
	window.removeEventListener("keyup", up);
	window.removeEventListener("blur", blur);
	};
	}, []);

	useEffect(draw, [strokes, kept, background, tone, paperSize]);
	useEffect(() => () => {
		if (frame.current !== null) cancelAnimationFrame(frame.current);
		clearTimeout(settleTimer.current);
	}, []);

	// The wheel pans; Ctrl+wheel (a trackpad pinch arrives so) zooms about the cursor. Not passive: the page must not scroll.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.current.height : 1;
			if (e.ctrlKey) {
				const r = canvas.getBoundingClientRect();
				setView(zoomAbout(view.current, Math.exp(-e.deltaY * unit * 0.01), e.clientX - r.left, e.clientY - r.top));
			} else {
				setView(panBy(view.current, -e.deltaX * unit, -e.deltaY * unit));
			}
		};
		canvas.addEventListener("wheel", onWheel, { passive: false });
		return () => canvas.removeEventListener("wheel", onWheel);
	}, []);

	const armHold = () => {
	clearTimeout(holdTimer.current);
	holdTimer.current = setTimeout(checkHold, HOLD_MS);
	};
	const disarmHold = () => {
	clearTimeout(holdTimer.current);
	holdTimer.current = undefined;
	holdSamples.current = [];
	angleSegments.current = [];
	};
	/** The pen has been still for a while: if it is mid-stroke and long enough, the stroke becomes a straight line (and follows the pen from here). */
	const checkHold = () => {
	const l = live.current;
	if (!l || l.erase || l.straight || l.points.length < 6) return;
	if (!isHeld(holdSamples.current, performance.now())) return;
	const first = { x: l.points[0]!, y: l.points[1]! };
	const last = { x: l.points[l.points.length - 3]!, y: l.points[l.points.length - 2]! };
	if (dist(first, last) * view.current.zoom < MIN_LINE_PX) return;
	l.straight = true;
	angleSegments.current = straightSegments([...keptRef.current, ...strokesRef.current]);
	l.points = linePoints(first, snapAngle(first, last));
	if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(8);
	draw();
	};
	const sample = (e: PointerEvent, out: number[]) => {
		// Mice and fingers report no real pressure: a steady middle value.
		const pressure = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
		const w = toWorld(view.current, e.clientX - rect.current.left, e.clientY - rect.current.top);
		out.push(Math.round(w.x * 10) / 10, Math.round(w.y * 10) / 10, Math.round(pressure * 100) / 100);
	};

	/** Mark the new strokes under the eraser's newest samples. */
	const eraseAt = (points: number[], from: number, hits: Set<number>, radius: number) => {
		const touch = (s: SketchStroke, i: number) => {
			if (hits.has(i)) return;
			for (let k = from; k < points.length; k += 3) {
				if (sketchStrokeHit(s, points[k]!, points[k + 1]!, radius)) {
					hits.add(i);
					return;
				}
			}
		};
		strokesRef.current.forEach(touch);
		// the sent page (dimmed): numbered after the working strokes; the view thaws it on the first one that goes
		const working = strokesRef.current.length;
		keptRef.current.forEach((s, j) => touch(s, working + j));
	};

	const local = (e: React.PointerEvent) => ({ x: e.clientX - rect.current.left, y: e.clientY - rect.current.top });

	return (
		<div ref={wrapRef} data-testid="sketch-viewport" className="absolute inset-0 overflow-hidden overscroll-contain">
			<canvas
				ref={canvasRef}
				data-testid="sketch-canvas"
				data-tool={tool}
				// JavaScript owns every gesture: there is no native scrolling on an infinite plane.
				style={{ touchAction: "none" }}
				className={`block size-full ${tool === "eraser" ? "cursor-cell" : "cursor-crosshair"}`}
				onPointerDown={(e) => {
					if (e.pointerType === "pen") {
						penNearAt.current = performance.now();
						notePenNear(); // the toolbar's palm guard shares it
						penSeen.current = true;
					}
					hover.current = null; // drawing now: the live stroke is the preview
					const box = e.currentTarget.getBoundingClientRect();
					rect.current = { left: box.left, top: box.top, width: box.width, height: box.height };
					if (e.pointerType === "touch") {
						// a palm beside the pen, or while it draws: not a finger
						// (a live FINGER stroke does not block a second finger: that one turns the gesture into a pan/zoom)
						if ((live.current && live.current.pointerType !== "touch") || performance.now() - penNearAt.current < PALM_MS) return;
						e.currentTarget.setPointerCapture(e.pointerId);
						const touchAt = local(e);
						gate.down(e.pointerId, touchAt.x, touchAt.y, e.width, e.height, performance.now());
						if (gate.touches.size >= 2) {
							// a second finger: the stroke the first began was a pan/zoom after all
							if (live.current) {
								live.current = null;
								draw();
							}
							// (the pinch begins on a later move, once the touches pass the palm gate: pinch-gate.ts)
							tap.current = gate.touches.size === 2 ? startTap(performance.now(), gate.touches) : tap.current && moveTap(tap.current, gate.touches, true);
							return;
							}
							if (penSeen.current) return; // with a pen about, one finger does nothing (no palm drags)
					} else if (e.pointerType === "mouse" && e.button === 1) {
						e.preventDefault();
						e.currentTarget.setPointerCapture(e.pointerId);
						drag.current = { pointerId: e.pointerId, ...local(e) };
						return;
					}
					if (spaceDown.current && (e.pointerType === "mouse" || e.pointerType === "pen") && e.button === 0) {
					e.preventDefault();
					e.currentTarget.setPointerCapture(e.pointerId);
					drag.current = { pointerId: e.pointerId, ...local(e) };
					return;
					}
					if (e.button !== 0 && e.button !== 5) return;
					if (live.current || gate.pinching) return;
					e.preventDefault();
					e.currentTarget.setPointerCapture(e.pointerId);
					const points: number[] = [];
					sample(e.nativeEvent, points);
					// The toolbar's eraser, the pen's eraser end (button 5), or its eraser button (buttons bit 32).
					const erasing = toolRef.current === "eraser" || e.button === 5 || (e.buttons & 32) !== 0;
					const l = {
						pointerId: e.pointerId,
						pointerType: e.pointerType,
						points,
						erase: erasing ? new Set<number>() : null,
						size: penWorldSize(brushRef.current.size, view.current.zoom),
						radius: eraserWorldRadius(eraserRef.current.radius, view.current.zoom),
						straight: false,
						cut: null,
						};
						live.current = l;
						if (!erasing) {
						holdSamples.current = [{ ...local(e), t: performance.now() }];
						armHold();
						}
					if (l.erase && eraserRef.current.mode === "stroke") eraseAt(points, 0, l.erase, l.radius);
					draw();
				}}
				onPointerMove={(e) => {
					if (e.pointerType === "pen") {
						penNearAt.current = performance.now(); // hovering counts: the palm is near
						notePenNear();
						if (!live.current && e.buttons === 0 && toolRef.current === "eraser") {
							hover.current = local(e);
							drawSoon();
						}
					}
					if (drag.current && drag.current.pointerId === e.pointerId) {
						const p = local(e);
						setView(panBy(view.current, p.x - drag.current.x, p.y - drag.current.y));
						drag.current = { pointerId: e.pointerId, ...p };
						return;
					}
					if (gate.has(e.pointerId)) {
						const touchAt = local(e);
						const frame = gate.move(e.pointerId, touchAt.x, touchAt.y, e.width, e.height, performance.now());
						if (tap.current) tap.current = moveTap(tap.current, gate.touches);
						if (frame) {
							if (frame.prev) setView(pinchStep(view.current, frame.prev, frame.next)); // the first ready move only sets the baseline: no jump
							return;
						}
					}
					if (!live.current || live.current.pointerId !== e.pointerId) return;
					const native = e.nativeEvent;
					const events = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
					const from = live.current.points.length;
					for (const ev of events.length > 0 ? events : [native]) sample(ev, live.current.points);
					if (!live.current.erase) {
					holdSamples.current.push({ ...local(e), t: performance.now() });
					if (holdSamples.current.length > 64) holdSamples.current.splice(0, holdSamples.current.length - 64);
					if (live.current.straight) {
					// a held line follows the pen: from the first point to wherever it is now, the angle snapped
					const pts = live.current.points;
					const first = { x: pts[0]!, y: pts[1]! };
					const now = { x: pts[pts.length - 3]!, y: pts[pts.length - 2]! };
					live.current.points = linePoints(first, snapAngle(first, now));
					} else armHold();
					}
					if (live.current.erase && eraserRef.current.mode === "stroke") eraseAt(live.current.points, from, live.current.erase, live.current.radius);
					drawSoon();
				}}
				onPointerUp={(e) => {
				if (tap.current && gate.has(e.pointerId)) {
				const lifted = liftTap(tap.current, performance.now());
				tap.current = lifted.tracker.cancelled || lifted.tapped ? null : lifted.tracker;
				if (lifted.tapped) onTwoFingerTapRef.current?.();
				}
				gate.up(e.pointerId); // whatever is left starts a fresh baseline
					if (drag.current?.pointerId === e.pointerId) drag.current = null;
					if (!live.current || live.current.pointerId !== e.pointerId) return;
					const { points, erase, size, radius } = live.current;
					live.current = null;
					disarmHold();
					if (erase) {
						if (eraserRef.current.mode === "pixel") onCut?.(thinPath(xyOf(points), radius / 4), radius);
						else if (erase.size > 0) onErase?.([...erase]);
						else draw();
					} else onStroke(penStroke({ color: brushRef.current.color, size }, points));
				}}
				onPointerLeave={() => {
					if (hover.current) {
						hover.current = null;
						drawSoon();
					}
				}}
				onPointerCancel={(e) => {
				// The OS took the pointer (a palm, a gesture): drop the stroke.
				tap.current = null;
				gate.up(e.pointerId);
					if (drag.current?.pointerId === e.pointerId) drag.current = null;
					if (!live.current || live.current.pointerId !== e.pointerId) return;
					live.current = null;
					disarmHold();
					draw();
					}}
			/>
			<ZoomIndicator zoomPct={zoomPct} />
		</div>
	);
}
