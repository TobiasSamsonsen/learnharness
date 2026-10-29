import { SKETCH_INK } from "@/src/core";

/**
 * The sheet's tone (owner, M13): a light or a DARK sheet. A display choice only: the strokes keep the colours they
 * were drawn in and the image the model reads stays white, so on a dark sheet the ink is SHOWN in a lighter variant
 * (black ink as near-white, the four colours as lighter tones) and the paper lines in a light grey. Mirrored in the
 * shell by android/.../InkSheet.kt (the same table). Remembered per device.
 */

export type SheetTone = "light" | "dark";

export const SHEET_COLOR: Record<SheetTone, string> = { light: "#ffffff", dark: "#1c1917" };

/** The palette's colours as shown on a dark sheet. */
const DARK_INK: Record<string, string> = {
	[SKETCH_INK]: "#f5f5f4",
	"#dc2626": "#f87171",
	"#16a34a": "#4ade80",
	"#ea580c": "#fb923c",
	"#2563eb": "#60a5fa",
};

/** A colour no table knows (an older sketch, another producer): dark ones are blended toward white. */
function lighten(hex: string): string {
	const n = parseInt(hex.slice(1), 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
	if (luminance >= 0.55) return hex;
	const mix = (c: number) => Math.round(c + (255 - c) * 0.55);
	return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** How a stroke's colour is shown on this sheet. */
export function displayInk(color: string | undefined, tone: SheetTone): string {
	const c = (color ?? SKETCH_INK).toLowerCase();
	if (tone === "light") return c;
	return DARK_INK[c] ?? (/^#[0-9a-f]{6}$/.test(c) ? lighten(c) : c);
}

const LS_KEY = "lh:sketch-sheet";

export function loadTone(): SheetTone {
	try {
		return (typeof localStorage === "undefined" ? null : localStorage.getItem(LS_KEY)) === "dark" ? "dark" : "light";
	} catch {
		return "light";
	}
}

export function saveTone(tone: SheetTone): void {
	try {
		localStorage.setItem(LS_KEY, tone);
	} catch {
		// a blocked store: the choice lasts for this view only
	}
}
