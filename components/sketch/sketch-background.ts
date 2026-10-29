import type { CSSProperties } from "react";
import type { SketchView } from "@/components/sketch/view-transform";

/**
 * The canvas' paper (owner, M13d): none, a grid, ruled lines or dots. A drawing aid only: it is drawn on the canvas
 * and never reaches the strokes or the image the model reads (that stays plain white). It follows the view, so a
 * zoom or a pan moves it with the ink; when zoomed far out the spacing doubles until the lines stay apart.
 * Remembered per device. The spacing has six steps (owner, 2026-10-29: so the lines can be followed without writing too small or
 * too large, or zooming); one choice for every paper, a slider that snaps.
 */

export const SKETCH_BACKGROUNDS = ["none", "grid", "ruled", "dots"] as const;
export type SketchBackground = (typeof SKETCH_BACKGROUNDS)[number];

/** The spacing steps, as multiples of the base spacing below: 50%, 75%, 100% (today's), 125%, 150%, 200%. */
export const PAPER_SIZES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const DEFAULT_PAPER_SIZE = 2;

/** World spacing at zoom 1 (owner defaults: grid 32, ruled 40). */
const BASE_STEP: Record<Exclude<SketchBackground, "none">, number> = { grid: 32, ruled: 40, dots: 32 };
/** Lines closer than this on screen are not drawn: the spacing doubles until they are. */
const MIN_SCREEN_STEP = 10;
export const BACKGROUND_COLOR = "rgba(100, 116, 139, 0.28)";
/** The paper lines on a dark sheet. */
const BACKGROUND_COLOR_DARK = "rgba(214, 211, 209, 0.22)";

export function backgroundColor(tone: "light" | "dark"): string {
	return tone === "dark" ? BACKGROUND_COLOR_DARK : BACKGROUND_COLOR;
}

/** The world spacing at this zoom. */
export function backgroundStep(kind: Exclude<SketchBackground, "none">, zoom: number, scale = 1): number {
let step = BASE_STEP[kind] * scale;
	while (step * zoom < MIN_SCREEN_STEP) step *= 2;
	return step;
}

/** Where the lines (or dot rows and columns) fall on a canvas of w x h screen pixels, in screen pixels. */
export function backgroundLines(kind: SketchBackground, view: SketchView, w: number, h: number, scale = 1): { xs: number[]; ys: number[] } {
	if (kind === "none" || !(w > 0) || !(h > 0)) return { xs: [], ys: [] };
	const step = backgroundStep(kind, view.zoom, scale);
	const along = (origin: number, length: number) => {
		const out: number[] = [];
		for (let w0 = Math.floor(origin / step) * step; (w0 - origin) * view.zoom <= length; w0 += step) out.push(Math.round((w0 - origin) * view.zoom * 100) / 100);
		return out;
	};
	// ruled paper is horizontal lines only; a grid and dots have both
	return { xs: kind === "ruled" ? [] : along(view.x, w), ys: along(view.y, h) };
}

/** The same paper as a CSS background for the native-ink surface (the shell draws under a transparent page). */
export function backgroundCss(kind: SketchBackground, view: SketchView, tone: "light" | "dark" = "light", scale = 1): CSSProperties {
	if (kind === "none") return {};
	const color = backgroundColor(tone);
	const step = backgroundStep(kind, view.zoom, scale) * view.zoom;
	// the first line sits where the world's first multiple of the step falls
	const ox = -(((view.x % (step / view.zoom)) + step / view.zoom) % (step / view.zoom)) * view.zoom;
	const oy = -(((view.y % (step / view.zoom)) + step / view.zoom) % (step / view.zoom)) * view.zoom;
	const lineX = `linear-gradient(to right, ${color} 1px, transparent 1px)`;
	const lineY = `linear-gradient(to bottom, ${color} 1px, transparent 1px)`;
	const dot = `radial-gradient(circle, ${color} 1.2px, transparent 1.6px)`;
	const size = `${step}px ${step}px`;
	if (kind === "grid") return { backgroundImage: `${lineX}, ${lineY}`, backgroundSize: `${size}, ${size}`, backgroundPosition: `${ox}px ${oy}px, ${ox}px ${oy}px` };
	if (kind === "ruled") return { backgroundImage: lineY, backgroundSize: size, backgroundPosition: `0px ${oy}px` };
	return { backgroundImage: dot, backgroundSize: size, backgroundPosition: `${ox - step / 2}px ${oy - step / 2}px` };
}

const LS_KEY = "lh:sketch-background";

export function loadBackground(): SketchBackground {
	try {
		const v = typeof localStorage === "undefined" ? null : localStorage.getItem(LS_KEY);
		return (SKETCH_BACKGROUNDS as readonly string[]).includes(v ?? "") ? (v as SketchBackground) : "none";
	} catch {
		return "none";
	}
}

export function saveBackground(kind: SketchBackground): void {
	try {
		localStorage.setItem(LS_KEY, kind);
	} catch {
		// a blocked store: the choice lasts for this view only
	}
}

/** The next paper in the toolbar's cycle. */
export function nextBackground(kind: SketchBackground): SketchBackground {
	return SKETCH_BACKGROUNDS[(SKETCH_BACKGROUNDS.indexOf(kind) + 1) % SKETCH_BACKGROUNDS.length]!;
}

/** The spacing, in world px at zoom 100%, of this paper at this step (for the slider's label). */
export function paperSpacing(kind: Exclude<SketchBackground, "none">, size: number): number {
	return Math.round(BASE_STEP[kind] * (PAPER_SIZES[size] ?? 1));
}

const SIZE_KEY = "lh:sketch-paper-size";

/** The remembered step (an index into PAPER_SIZES); anything unknown is the default. */
export function loadPaperSize(): number {
	try {
		const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(SIZE_KEY);
		const v = raw === null || raw.trim() === "" ? NaN : Number(raw);
		return Number.isInteger(v) && v >= 0 && v < PAPER_SIZES.length ? v : DEFAULT_PAPER_SIZE;
	} catch {
		return DEFAULT_PAPER_SIZE;
	}
}

export function savePaperSize(size: number): void {
	try {
		localStorage.setItem(SIZE_KEY, String(size));
	} catch {
		// a blocked store: the choice lasts for this view only
	}
}
