import { sketchStrokeBounds, sketchStrokeCut, type SketchStroke } from "@/src/core";
import { thinPath, type SketchView } from "@/components/sketch/view-transform";

/**
 * The maths behind the canvas's cached ink layer (no DOM). Committed ink is
 * rasterised once into an offscreen bitmap that covers the viewport plus a
 * margin on every side; a frame is then one blit of that bitmap plus the live
 * stroke, instead of a refill of every stroke on the page. While the view
 * pans or zooms the bitmap is drawn with the new transform (cheap, a little
 * soft); once the view settles it is rasterised again, sharp, filling only the
 * strokes whose bounds meet the region it covers.
 */

/** The margin around the viewport, as a fraction of its width and height, each side. */
export const LAYER_MARGIN = 0.25;
/** The longest side the layer's bitmap may have, device pixels (a bigger one drops to a lower density). */
export const LAYER_MAX_SIDE = 8192;

export interface Rect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** The layer's bitmap: its size in device pixels, its scale (device pixels per CSS pixel) and its margin in CSS pixels. */
export interface LayerGeometry {
	width: number;
	height: number;
	scale: number;
	mx: number;
	my: number;
}

/** The layer for a viewport of `cssW` x `cssH` CSS pixels at screen density `dpr`. */
export function layerGeometry(cssW: number, cssH: number, dpr: number): LayerGeometry {
	const mx = Math.round(cssW * LAYER_MARGIN);
	const my = Math.round(cssH * LAYER_MARGIN);
	const totalW = cssW + 2 * mx;
	const totalH = cssH + 2 * my;
	const scale = Math.min(dpr, LAYER_MAX_SIDE / Math.max(totalW, totalH, 1));
	return { width: Math.max(1, Math.ceil(totalW * scale)), height: Math.max(1, Math.ceil(totalH * scale)), scale, mx, my };
}

/** The part of the world the layer covers when rasterised at `view`. */
export function layerWorldRect(view: SketchView, g: LayerGeometry): Rect {
	return {
		minX: view.x - g.mx / view.zoom,
		minY: view.y - g.my / view.zoom,
		maxX: view.x + (g.width / g.scale - g.mx) / view.zoom,
		maxY: view.y + (g.height / g.scale - g.my) / view.zoom,
	};
}

/** Where (CSS pixels, canvas-relative) and how large to draw a layer rasterised at `layerView` so it fits `view`. */
export function layerBlit(layerView: SketchView, view: SketchView, g: LayerGeometry): { x: number; y: number; w: number; h: number } {
	const ratio = view.zoom / layerView.zoom;
	return {
		x: (layerView.x - g.mx / layerView.zoom - view.x) * view.zoom,
		y: (layerView.y - g.my / layerView.zoom - view.y) * view.zoom,
		w: (g.width / g.scale) * ratio,
		h: (g.height / g.scale) * ratio,
	};
}

export const sameView = (a: SketchView, b: SketchView): boolean => a.zoom === b.zoom && a.x === b.x && a.y === b.y;

/** Does the stroke's outline possibly meet `rect`? Its box grown by its width (the outline reaches half of it past the points). */
export function strokeVisible(s: SketchStroke, rect: Rect): boolean {
	const b = sketchStrokeBounds(s);
	if (!b) return false;
	return !(b.maxX + s.size < rect.minX || b.minX - s.size > rect.maxX || b.maxY + s.size < rect.minY || b.minY - s.size > rect.maxY);
}

/** Are the first `n` strokes of both lists the very same objects? */
export function sameStrokes(a: readonly SketchStroke[], b: readonly SketchStroke[], n = Math.max(a.length, b.length)): boolean {
	if (a.length < n || b.length < n) return false;
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Is `next` just `prev` with one stroke added at the end? */
export const isAppend = (prev: readonly SketchStroke[], next: readonly SketchStroke[]): boolean => next.length === prev.length + 1 && sameStrokes(prev, next, prev.length);

export function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

/** The x, y of flat [x, y, pressure] triples, as flat [x, y, …]. */
export function xyOf(points: readonly number[]): number[] {
	const out: number[] = [];
	for (let k = 0; k + 1 < points.length; k += 3) out.push(points[k]!, points[k + 1]!);
	return out;
}

/** A pixel-eraser gesture's progress: how many samples were cut so far, and what is left of each stroke it touched. */
export interface CutState {
	n: number;
	pieces: Map<SketchStroke, SketchStroke[]>;
}

export const newCut = (): CutState => ({ n: 0, pieces: new Map() });

/**
 * Cut the strokes of `lists` by the samples the eraser gave since the last call (`points`: flat [x, y, pressure], world).
 * Only the new stretch of the path is cut, and only strokes whose box it meets are looked at, so a frame costs by the
 * stretch and the strokes near it, not by the page. Returns the strokes whose pieces changed.
 */
export function advanceCut(cut: CutState, points: readonly number[], radius: number, lists: readonly (readonly SketchStroke[])[]): SketchStroke[] {
	const n = Math.floor(points.length / 3);
	if (n === cut.n) return [];
	const tail = thinPath(xyOf(points.slice(Math.max(0, cut.n - 1) * 3)), radius / 4);
	cut.n = n;
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (let k = 0; k + 1 < tail.length; k += 2) {
		x0 = Math.min(x0, tail[k]!), x1 = Math.max(x1, tail[k]!);
		y0 = Math.min(y0, tail[k + 1]!), y1 = Math.max(y1, tail[k + 1]!);
	}
	const changed: SketchStroke[] = [];
	for (const list of lists) {
		for (const s of list) {
			const b = sketchStrokeBounds(s);
			if (!b) continue;
			const reach = radius + s.size / 2;
			if (x1 + reach < b.minX || x0 - reach > b.maxX || y1 + reach < b.minY || y0 - reach > b.maxY) continue;
			const next: SketchStroke[] = [];
			let touched = false;
			for (const piece of cut.pieces.get(s) ?? [s]) {
				const left = sketchStrokeCut(piece, tail, radius);
				if (left) {
					touched = true;
					next.push(...left);
				} else next.push(piece);
			}
			if (touched) {
				cut.pieces.set(s, next);
				changed.push(s);
			}
		}
	}
	return changed;
}
