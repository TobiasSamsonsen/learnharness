/**
 * The infinite canvas's view (M13c): pure maths, no DOM. The page is an
 * unbounded plane of WORLD coordinates (the stroke points' own space, any
 * origin, negatives included). The view says which part of it the canvas
 * shows: `x`, `y` are the world coordinates of the canvas' top-left corner,
 * `zoom` is screen pixels per world unit.
 */

export interface SketchView {
	zoom: number;
	x: number;
	y: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const HOME_VIEW: SketchView = { zoom: 1, x: 0, y: 0 };

/** Stroke widths the validator accepts (core/sketch.ts: 0.5 to 64). */
const MIN_WORLD_SIZE = 0.5;
const MAX_WORLD_SIZE = 64;

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** The world point under a canvas (screen) point. */
export function toWorld(view: SketchView, sx: number, sy: number): { x: number; y: number } {
	return { x: view.x + sx / view.zoom, y: view.y + sy / view.zoom };
}

/** The canvas (screen) point of a world point. */
export function toScreen(view: SketchView, wx: number, wy: number): { x: number; y: number } {
	return { x: (wx - view.x) * view.zoom, y: (wy - view.y) * view.zoom };
}

/** Zoom by `factor` keeping the world point under the screen point (sx, sy) where it is. */
export function zoomAbout(view: SketchView, factor: number, sx: number, sy: number): SketchView {
	const zoom = clampZoom(view.zoom * factor);
	const at = toWorld(view, sx, sy);
	return { zoom, x: at.x - sx / zoom, y: at.y - sy / zoom };
}

/** Move the view so the content follows a drag of (dsx, dsy) screen pixels. */
export function panBy(view: SketchView, dsx: number, dsy: number): SketchView {
	return { zoom: view.zoom, x: view.x - dsx / view.zoom, y: view.y - dsy / view.zoom };
}

/**
 * The pen's width in WORLD units for a width chosen as how it should FEEL on
 * screen (owner, M13c, adapting the one app measured to behave this way:
 * Infinite Canvas keeps the apparent width at any zoom): zoomed in the same
 * pen writes finer in world terms. Kept inside what the validator accepts;
 * the model's render normalises by writing size, so tiny world ink stays
 * readable (core/sketch.ts, glyph-adaptive scale).
 */
export function penWorldSize(screenSize: number, zoom: number): number {
	return Math.round(Math.min(MAX_WORLD_SIZE, Math.max(MIN_WORLD_SIZE, screenSize / zoom)) * 100) / 100;
}

/**
 * The view as the shell will hold it: the wire carries four decimals of zoom and two of the position, so the web
 * adopts exactly those numbers (the shell and the web then never disagree about where a point is).
 */
export function roundView(v: SketchView): SketchView {
	return { zoom: Math.round(clampZoom(v.zoom) * 10000) / 10000, x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100 };
}

/** An eraser radius chosen on screen, in world units. */
export const eraserWorldRadius = (screenRadius: number, zoom: number): number => screenRadius / zoom;

/**
 * Where to open the canvas: the home view when the ink sits inside it,
 * otherwise a view that shows all the ink (never zoomed in past 1, never
 * out past the minimum), with a little air around it.
 */
export function fitInk(points: readonly (readonly number[])[], width: number, height: number): SketchView {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const p of points) {
		for (let k = 0; k + 1 < p.length; k += 3) {
			x0 = Math.min(x0, p[k]!), x1 = Math.max(x1, p[k]!);
			y0 = Math.min(y0, p[k + 1]!), y1 = Math.max(y1, p[k + 1]!);
		}
	}
	if (!Number.isFinite(x0) || width <= 0 || height <= 0) return HOME_VIEW;
	const pad = 24;
	if (x0 >= 0 && y0 >= 0 && x1 <= width - pad && y1 <= height - pad) return HOME_VIEW;
	const zoom = clampZoom(Math.min(1, (width - 2 * pad) / Math.max(1, x1 - x0), (height - 2 * pad) / Math.max(1, y1 - y0)));
	return { zoom, x: x0 - pad / zoom, y: y0 - pad / zoom };
}

/**
 * An eraser path (flat [x, y, …]) with samples closer than `step` dropped, the first and last kept. A 240 Hz pen
 * fills a path with samples far finer than the eraser's reach; cutting against every one of them each frame
 * costs quadratically. At a step of a quarter of the radius the cut is indistinguishable.
 */
export function thinPath(path: readonly number[], step: number): number[] {
	if (path.length <= 4 || !(step > 0)) return [...path];
	const out = [path[0]!, path[1]!];
	let lx = path[0]!, ly = path[1]!;
	for (let k = 2; k + 1 < path.length; k += 2) {
		if (Math.hypot(path[k]! - lx, path[k + 1]! - ly) >= step) {
			out.push(path[k]!, path[k + 1]!);
			lx = path[k]!, ly = path[k + 1]!;
		}
	}
	const n = path.length;
	if (out[out.length - 2] !== path[n - 2] || out[out.length - 1] !== path[n - 1]) out.push(path[n - 2]!, path[n - 1]!);
	return out;
}

/** The pinch of two fingers: where the midpoint is and how far apart they are. */
export function pinchOf(a: { x: number; y: number }, b: { x: number; y: number }): { mx: number; my: number; dist: number } {
	return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
}

/** One step of a pinch: zoom by the change in distance about the new midpoint, and follow the midpoint's drift. */
export function pinchStep(view: SketchView, prev: ReturnType<typeof pinchOf>, next: ReturnType<typeof pinchOf>): SketchView {
	const factor = prev.dist > 0 && next.dist > 0 ? next.dist / prev.dist : 1;
	// zoom about where the fingers were, then move by how far their midpoint travelled
	return panBy(zoomAbout(view, factor, prev.mx, prev.my), next.mx - prev.mx, next.my - prev.my);
}
