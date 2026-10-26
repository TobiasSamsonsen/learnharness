import { identLatex, type Timing } from "@/src/core";
import { labelHtml, labelSvg, mathHtml, measure } from "@/components/figures/figure-label";

/**
 * A ```timing figure as svg (figures phase 3, owner 2026-10-26) — the
 * WaveJSON subset the course needs, drawn on the theme instead of
 * WaveDrom's fixed light skin: 0/1 (and h/l), x (hatched), z (middle),
 * p/n clocks (P/N with an edge arrow), data segments (= and 2–9, labelled
 * from "data"), '.' to continue, '|' as a gap. A signal with "hide" is a
 * blank row to fill in. Computed signals (from the linked logic diagram)
 * are drawn in the accent colour.
 */

const SW = 28;
const H = 18;
const ROW = 30;
const ACCENT = "#60a5fa";

type Seg = { kind: "0" | "1" | "x" | "z" | "data" | "clock"; from: number; to: number; edge?: "p" | "n"; arrow?: boolean; label?: string };

/** The wave as segments of one kind each (clocks one per slot). */
function segments(wave: string, data: string[]): { segs: Seg[]; gaps: number[] } {
	const segs: Seg[] = [];
	const gaps: number[] = [];
	let dataIdx = 0;
	let last: Seg | null = null;
	[...wave].forEach((c, k) => {
		if (c === "|") {
			gaps.push(k);
			c = ".";
		}
		if (c === "." && last) {
			if (last.kind === "clock") {
				last = { ...last, from: k, to: k + 1 };
				segs.push(last);
			} else last.to = k + 1;
			return;
		}
		const kind: Seg["kind"] = "pPnN".includes(c) ? "clock" : "1hH".includes(c) ? "1" : "0lL".includes(c) ? "0" : c === "z" ? "z" : /[=2-9]/.test(c) ? "data" : "x";
		last = { kind, from: k, to: k + 1 };
		if (kind === "clock") {
			last.edge = c === "p" || c === "P" ? "p" : "n";
			last.arrow = c === "P" || c === "N";
		}
		if (kind === "data") last.label = data[dataIdx++] ?? "";
		segs.push(last);
	});
	return { segs, gaps };
}

export function renderTimingSvg(t: Timing, fontPx: number): string {
	const small = Math.round(fontPx * 0.8);
	const names = t.signals.map((s) => (s ? measure(mathHtml(identLatex(s.name)), fontPx) : null));
	const left = Math.max(20, ...names.map((l) => (l ? l.w : 0))) + 14;
	const width = left + t.slots * SW + 10;
	const top = t.tick !== undefined ? small + 10 : 6;
	const height = top + t.signals.length * ROW + 6;
	const parts: string[] = [];
	const xOf = (k: number) => left + k * SW;

	// slot grid and ticks
	for (let k = 0; k <= t.slots; k++) parts.push(`<line x1="${xOf(k)}" x2="${xOf(k)}" y1="${top - 2}" y2="${height - 4}" stroke="currentColor" stroke-opacity="0.1"/>`);
	if (t.tick !== undefined) {
		for (let k = 0; k < t.slots; k++) {
			parts.push(`<text x="${xOf(k) + SW / 2}" y="${small}" font-size="${small}" text-anchor="middle" fill="currentColor" opacity="0.6">${t.tick + k}</text>`);
		}
	}

	t.signals.forEach((s, row) => {
		if (!s) return;
		const y0 = top + row * ROW + (ROW - H) / 2;
		const hi = y0;
		const lo = y0 + H;
		const mid = y0 + H / 2;
		const name = names[row]!;
		parts.push(labelSvg(name, left - 10 - name.w, mid - name.h / 2, fontPx));
		if (s.hide || !s.wave) {
			parts.push(`<rect x="${xOf(0)}" y="${hi}" width="${t.slots * SW}" height="${H}" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.25" stroke-dasharray="3 3"/>`);
			return;
		}
		const color = s.computed ? ACCENT : "currentColor";
		const stroke = `stroke="${color}" stroke-width="1.6" fill="none" stroke-linejoin="round"`;
		const { segs, gaps } = segments(s.wave, s.data ?? []);
		let prevLevel: number | null = null;
		for (const seg of segs) {
			const x1 = xOf(seg.from);
			const x2 = xOf(seg.to);
			if (seg.kind === "clock") {
				const xm = (x1 + x2) / 2;
				const [first, second] = seg.edge === "p" ? [hi, lo] : [lo, hi];
				const start = prevLevel ?? (seg.edge === "p" ? lo : hi);
				parts.push(`<path d="M${x1} ${start}V${first}H${xm}V${second}H${x2}" ${stroke}/>`);
				if (seg.arrow) parts.push(`<path d="M${x1 - 3} ${seg.edge === "p" ? mid + 2 : mid - 2}L${x1} ${seg.edge === "p" ? mid - 3 : mid + 3}L${x1 + 3} ${seg.edge === "p" ? mid + 2 : mid - 2}" ${stroke}/>`);
				prevLevel = second;
				continue;
			}
			if (seg.kind === "0" || seg.kind === "1") {
				const level = seg.kind === "1" ? hi : lo;
				const from = prevLevel ?? level;
				parts.push(`<path d="M${x1} ${from}L${x1 + (from === level ? 0 : 3)} ${level}H${x2}" ${stroke}/>`);
				prevLevel = level;
				continue;
			}
			prevLevel = null;
			if (seg.kind === "z") {
				parts.push(`<path d="M${x1} ${mid}H${x2}" ${stroke}/>`);
				continue;
			}
			// x and data: a hexagonal box; x is hatched
			const box = `M${x1} ${mid}L${x1 + 3} ${hi}H${x2 - 3}L${x2} ${mid}L${x2 - 3} ${lo}H${x1 + 3}Z`;
			if (seg.kind === "x") {
				let hatch = "";
				for (let x = x1 + 2; x < x2 - 2; x += 6) hatch += `M${x} ${lo}L${Math.min(x + H * 0.6, x2 - 2)} ${hi}`;
				parts.push(`<path d="${box}" ${stroke}/><path d="${hatch}" stroke="${color}" stroke-opacity="0.45" stroke-width="1"/>`);
			} else {
				parts.push(`<path d="${box}" ${stroke} fill="${color}" fill-opacity="0.08"/>`);
				if (seg.label) {
					const l = measure(labelHtml(seg.label), small);
					parts.push(labelSvg(l, (x1 + x2) / 2 - l.w / 2, mid - l.h / 2, small));
				}
			}
		}
		for (const k of gaps) {
			const x = xOf(k);
			parts.push(`<path d="M${x - 4} ${lo + 3}L${x + 1} ${hi - 3}M${x - 1} ${lo + 3}L${x + 4} ${hi - 3}" stroke="currentColor" stroke-width="1.2"/>`);
		}
	});

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Timing diagram">` +
		parts.join("") +
		`</svg>`
	);
}
