import type { CSSProperties } from "react";
import type { SketchView } from "@/components/sketch/view-transform";

/**
 * The canvas' paper (owner, M13d): none, a grid, ruled lines or dots. A drawing aid only: it is drawn on the canvas
 * and never reaches the strokes or the image the model reads (that stays plain white). It follows the view, so a
 * zoom or a pan moves it with the ink; when zoomed far out the spacing doubles until the lines stay apart.
 * Remembered per device.
 */

export const SKETCH_BACKGROUNDS = ["none", "grid", "ruled", "dots"] as const;
export type SketchBackground = (typeof SKETCH_BACKGROUNDS)[number];

/** World spacing at zoom 1 (owner defaults: grid 32, ruled 40). */
const BASE_STEP: Record<Exclude<SketchBackground, "none">, number> = { grid: 32, ruled: 40, dots: 32 };
/** Lines closer than this on screen are not drawn: the spacing doubles until they are. */
const MIN_SCREEN_STEP = 10;
export const BACKGROUND_COLOR = "rgba(100, 116, 139, 0.28)";

/** The world spacing at this zoom. */
export function backgroundStep(kind: Exclude<SketchBackground, "none">, zoom: number): number {
	let step = BASE_STEP[kind];
	while (step * zoom < MIN_SCREEN_STEP) step *= 2;
	return step;
}

/** Where the lines (or dot rows and columns) fall on a canvas of w x h screen pixels, in screen pixels. */
export function backgroundLines(kind: SketchBackground, view: SketchView, w: number, h: number): { xs: number[]; ys: number[] } {
	if (kind === "none" || !(w > 0) || !(h > 0)) return { xs: [], ys: [] };
	const step = backgroundStep(kind, view.zoom);
	const along = (origin: number, length: number) => {
		const out: number[] = [];
		for (let w0 = Math.floor(origin / step) * step; (w0 - origin) * view.zoom <= length; w0 += step) out.push(Math.round((w0 - origin) * view.zoom * 100) / 100);
		return out;
	};
	// ruled paper is horizontal lines only; a grid and dots have both
	return { xs: kind === "ruled" ? [] : along(view.x, w), ys: along(view.y, h) };
}

/** The same paper as a CSS background for the native-ink surface (the shell draws under a transparent page). */
export function backgroundCss(kind: SketchBackground, view: SketchView): CSSProperties {
	if (kind === "none") return {};
	const step = backgroundStep(kind, view.zoom) * view.zoom;
	// the first line sits where the world's first multiple of the step falls
	const ox = -(((view.x % (step / view.zoom)) + step / view.zoom) % (step / view.zoom)) * view.zoom;
	const oy = -(((view.y % (step / view.zoom)) + step / view.zoom) % (step / view.zoom)) * view.zoom;
	const lineX = `linear-gradient(to right, ${BACKGROUND_COLOR} 1px, transparent 1px)`;
	const lineY = `linear-gradient(to bottom, ${BACKGROUND_COLOR} 1px, transparent 1px)`;
	const dot = `radial-gradient(circle, ${BACKGROUND_COLOR} 1.2px, transparent 1.6px)`;
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
