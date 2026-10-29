import assert from "node:assert/strict";
import { describe, it } from "node:test";

const memory = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
	getItem: (k: string) => memory.get(k) ?? null,
	setItem: (k: string, v: string) => void memory.set(k, v),
	removeItem: (k: string) => void memory.delete(k),
};
import { displayInk, loadTone, saveTone, SHEET_COLOR } from "../components/sketch/sketch-sheet.ts";
import { backgroundColor, backgroundCss } from "../components/sketch/sketch-background.ts";

describe("the sheet's tone (display only: the strokes and the model's image keep their colours)", () => {
	it("a light sheet shows ink as drawn; the default ink needs no colour", () => {
		assert.equal(displayInk(undefined, "light"), "#111111");
		assert.equal(displayInk("#DC2626", "light"), "#dc2626");
	});

	it("a dark sheet shows the palette in lighter tones (black as near-white), the same table as the shell", () => {
		assert.equal(displayInk(undefined, "dark"), "#f5f5f4");
		assert.equal(displayInk("#111111", "dark"), "#f5f5f4");
		assert.equal(displayInk("#dc2626", "dark"), "#f87171");
		assert.equal(displayInk("#16a34a", "dark"), "#4ade80");
		assert.equal(displayInk("#ea580c", "dark"), "#fb923c");
		assert.equal(displayInk("#2563eb", "dark"), "#60a5fa");
	});

	it("a colour outside the palette is lightened when dark and left alone when light or already light", () => {
		assert.equal(displayInk("#203040", "dark"), "#9ba2a9", "55% toward white (the shell's InkSheetTest checks the same number)");
		assert.equal(displayInk("#ffe680", "dark"), "#ffe680");
		assert.equal(displayInk("#203040", "light"), "#203040");
	});

	it("every dark-sheet ink is readable on the dark sheet (contrast against #1c1917 of at least 4.5)", () => {
		const lum = (hex: string) => {
			const n = parseInt(hex.slice(1), 16);
			const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
				const s = v / 255;
				return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
		};
		const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
		for (const ink of ["#111111", "#dc2626", "#16a34a", "#ea580c", "#2563eb"]) {
			assert.ok(ratio(displayInk(ink, "dark"), SHEET_COLOR.dark) >= 4.5, ink + " " + ratio(displayInk(ink, "dark"), SHEET_COLOR.dark));
		}
	});

	it("the paper lines follow the tone", () => {
		assert.notEqual(backgroundColor("light"), backgroundColor("dark"));
		const dark = String(backgroundCss("grid", { zoom: 1, x: 0, y: 0 }, "dark").backgroundImage);
		assert.ok(dark.includes(backgroundColor("dark")) && !dark.includes(backgroundColor("light")));
	});

	it("the tone is remembered per device, and anything else means light", () => {
		localStorage.removeItem("lh:sketch-sheet");
		assert.equal(loadTone(), "light");
		saveTone("dark");
		assert.equal(loadTone(), "dark");
		localStorage.setItem("lh:sketch-sheet", "purple");
		assert.equal(loadTone(), "light");
		localStorage.removeItem("lh:sketch-sheet");
	});
});
