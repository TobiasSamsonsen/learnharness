import { SKETCH_INK, type SketchStroke } from "@/src/core";

/**
 * The pen's look (owner, M13, 2026-10-29): five colours and three widths.
 * The palette stays clear of the margin bracket's magenta (core/sketch.ts),
 * so ink can never be mistaken for "new or edited". The choice is a
 * per-device convenience, remembered in localStorage.
 */

export const SKETCH_COLORS = [
	{ name: "Black", value: SKETCH_INK },
	{ name: "Red", value: "#dc2626" },
	{ name: "Green", value: "#16a34a" },
	{ name: "Orange", value: "#ea580c" },
	{ name: "Blue", value: "#2563eb" },
] as const;

export const SKETCH_WIDTHS = [
	{ name: "Thin", value: 2 },
	{ name: "Medium", value: 4 },
	{ name: "Thick", value: 8 },
] as const;

export interface PenSettings {
	/** "#rrggbb", one of SKETCH_COLORS. */
	color: string;
	/** Base diameter in canvas CSS pixels, one of SKETCH_WIDTHS. */
	size: number;
}

export const DEFAULT_PEN: PenSettings = { color: SKETCH_INK, size: 4 };

const LS_KEY = "lh:sketch-pen";

function storage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

/** The remembered pen; anything unknown or damaged falls back to the default. */
export function loadPen(): PenSettings {
	try {
		const raw = storage()?.getItem(LS_KEY);
		if (!raw) return DEFAULT_PEN;
		const v = JSON.parse(raw) as Partial<PenSettings> | null;
		const color = SKETCH_COLORS.find((c) => c.value === v?.color)?.value;
		const size = SKETCH_WIDTHS.find((w) => w.value === v?.size)?.value;
		return { color: color ?? DEFAULT_PEN.color, size: size ?? DEFAULT_PEN.size };
	} catch {
		return DEFAULT_PEN;
	}
}

export function savePen(pen: PenSettings): void {
	try {
		storage()?.setItem(LS_KEY, JSON.stringify(pen));
	} catch {
		// a blocked store: the choice lasts for this view only
	}
}

/** A finished stroke in the pen's look. The default ink carries no colour. */
export function penStroke(pen: PenSettings, points: number[]): SketchStroke {
	return pen.color === SKETCH_INK ? { size: pen.size, points } : { size: pen.size, color: pen.color, points };
}

/**
 * The eraser (owner, M13): "pixel" cuts the part of a stroke the eraser passes
 * over (also on ink already sent, M13c); "stroke" removes whole strokes. The
 * radius is in canvas CSS pixels.
 */
export type EraserMode = "pixel" | "stroke";

export const SKETCH_ERASER_SIZES = [
	{ name: "Small", value: 10 },
	{ name: "Medium", value: 20 },
	{ name: "Large", value: 40 },
] as const;

export interface EraserSettings {
	mode: EraserMode;
	radius: number;
}

export const DEFAULT_ERASER: EraserSettings = { mode: "pixel", radius: 20 };

const ERASER_KEY = "lh:sketch-eraser";

export function loadEraser(): EraserSettings {
	try {
		const raw = storage()?.getItem(ERASER_KEY);
		if (!raw) return DEFAULT_ERASER;
		const v = JSON.parse(raw) as Partial<EraserSettings> | null;
		const radius = SKETCH_ERASER_SIZES.find((s) => s.value === v?.radius)?.value;
		return { mode: v?.mode === "stroke" ? "stroke" : "pixel", radius: radius ?? DEFAULT_ERASER.radius };
	} catch {
		return DEFAULT_ERASER;
	}
}

export function saveEraser(eraser: EraserSettings): void {
	try {
		storage()?.setItem(ERASER_KEY, JSON.stringify(eraser));
	} catch {
		// a blocked store: the choice lasts for this view only
	}
}
