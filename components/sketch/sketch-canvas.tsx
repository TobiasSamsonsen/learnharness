"use client";

import { useEffect, useRef, useState } from "react";
import { SKETCH_INK, sketchStrokeCut, sketchStrokeHit, sketchStrokePath, type SketchStroke } from "@/src/core";
import { DEFAULT_ERASER, DEFAULT_PEN, penStroke, type EraserSettings, type PenSettings } from "@/components/sketch/pen-settings";
import { backgroundColor, backgroundLines, PAPER_SIZES, DEFAULT_PAPER_SIZE, type SketchBackground } from "@/components/sketch/sketch-background";
import { displayInk, SHEET_COLOR, type SheetTone } from "@/components/sketch/sketch-sheet";
import { ZoomIndicator } from "@/components/sketch/zoom-indicator";
import { notePenNear } from "@/components/sketch/palm-guard";
import { liftTap, moveTap, startTap, type TapTracker } from "@/components/sketch/tap-gesture";
import { dist, HOLD_MS, isHeld, linePoints, MIN_LINE_PX, snapAngle } from "@/components/sketch/straight-line";
import { eraserWorldRadius, fitInk, HOME_VIEW, panBy, penWorldSize, pinchOf, pinchStep, thinPath, toWorld, zoomAbout, type SketchView } from "@/components/sketch/view-transform";

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
 * the canvas shows. The pen keeps its width on SCREEN at any zoom (the world
 * width is the chosen width over the zoom, clamped), so zooming in lets the
 * learner write fine.
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
	const live = useRef<{ pointerId: number; pointerType: string; points: number[]; erase: Set<number> | null; size: number; radius: number; straight: boolean } | null>(null);
	// Hold to straighten (M16c): where the pen has been (screen px, with times) and the timer that checks it stayed put
	const holdSamples = useRef<{ x: number; y: number; t: number }[]>([]);
	const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
	const touches = useRef(new Map<number, { x: number; y: number }>());
	const pinch = useRef<ReturnType<typeof pinchOf> | null>(null);
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
		ctx.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, -v.x * v.zoom * dpr, -v.y * v.zoom * dpr);
		ctx.globalAlpha = KEPT_ALPHA;
		for (const s of keptRef.current) {
			ctx.fillStyle = displayInk(s.color, tone);
			ctx.fill(pathOf(s));
		}
		const hits = live.current?.erase;
		// the pixel eraser shows its cut live: a touched stroke is drawn as its pieces
		const radius = live.current?.radius ?? 0;
		const cutPath = live.current?.erase && eraserRef.current.mode === "pixel" ? thinPath(xyOf(live.current.points), radius / 4) : null;
		strokesRef.current.forEach((s, i) => {
			const pieces = cutPath ? sketchStrokeCut(s, cutPath, radius) : null;
			// sent ink being edited (thawed, marked `fresh: false`) stays dimmed like the kept page; a stroke the
			// stroke eraser is over fades until the gesture ends
			ctx.globalAlpha = s.fresh === false ? KEPT_ALPHA : hits?.has(i) && !cutPath ? 0.2 : 1;
			ctx.fillStyle = displayInk(s.color, tone);
			if (pieces) for (const piece of pieces) ctx.fill(new Path2D(sketchStrokePath(piece)));
			else ctx.fill(pathOf(s));
		});
		ctx.globalAlpha = 1;
		if (live.current && !live.current.erase && live.current.points.length >= 3) {
			const l = penStroke({ color: brushRef.current.color, size: live.current.size }, live.current.points);
			ctx.fillStyle = displayInk(l.color, tone);
			ctx.fill(new Path2D(sketchStrokePath(l)));
		}
		// the hover preview, in screen space: the eraser's reach, or the pen's own width in its colour
		if (hover.current && !live.current) {
			const erasing = toolRef.current === "eraser";
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.beginPath();
			ctx.arc(hover.current.x, hover.current.y, erasing ? eraserRef.current.radius : Math.max(1.5, brushRef.current.size / 2), 0, Math.PI * 2);
			ctx.lineWidth = 1;
			ctx.strokeStyle = erasing ? "#64748b" : displayInk(brushRef.current.color, tone);
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

	const setView = (next: SketchView) => {
	view.current = next;
	setZoomPct(Math.round(next.zoom * 100));
	drawSoon();
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
		strokesRef.current.forEach((s, i) => {
			if (hits.has(i)) return;
			for (let k = from; k < points.length; k += 3) {
				if (sketchStrokeHit(s, points[k]!, points[k + 1]!, radius)) {
					hits.add(i);
					return;
				}
			}
		});
	};

	const local = (e: React.PointerEvent) => ({ x: e.clientX - rect.current.left, y: e.clientY - rect.current.top });
	const firstTwo = () => {
		const [a, b] = [...touches.current.values()];
		return pinchOf(a!, b!);
	};

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
						touches.current.set(e.pointerId, local(e));
						if (touches.current.size >= 2) {
							// a second finger: the stroke the first began was a pan/zoom after all
							if (live.current) {
								live.current = null;
								draw();
							}
							pinch.current = firstTwo();
							tap.current = touches.current.size === 2 ? startTap(performance.now(), touches.current) : tap.current && moveTap(tap.current, touches.current, true);
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
					if (live.current || pinch.current) return;
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
						if (!live.current && e.buttons === 0) {
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
					if (touches.current.has(e.pointerId)) {
					touches.current.set(e.pointerId, local(e));
					if (tap.current) tap.current = moveTap(tap.current, touches.current);
						if (pinch.current && touches.current.size >= 2) {
							const next = firstTwo();
							setView(pinchStep(view.current, pinch.current, next));
							pinch.current = next;
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
				if (tap.current && touches.current.has(e.pointerId)) {
				const lifted = liftTap(tap.current, performance.now());
				tap.current = lifted.tracker.cancelled || lifted.tapped ? null : lifted.tracker;
				if (lifted.tapped) onTwoFingerTapRef.current?.();
				}
				touches.current.delete(e.pointerId);
				if (touches.current.size < 2) pinch.current = null;
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
				touches.current.delete(e.pointerId);
					if (touches.current.size < 2) pinch.current = null;
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
