import { identLatex, type PlotData } from "@/src/core";
import { labelHtml, labelSvg, mathHtml, measure } from "@/components/figures/figure-label";

/**
 * A ```plot as svg (figures phase 1, owner 2026-10-26): nice-tick axes,
 * a faint grid, the curves (the first in the text colour, then a fixed
 * palette), sample stems, dashed markers and a legend. Synchronous — the
 * numbers are computed in core (computePlot).
 */

const W = 520;
const H = 290;
const PALETTE = ["currentColor", "#60a5fa", "#f59e0b", "#34d399", "#f472b6", "#a78bfa"];

/** About `count` round tick values covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 6): number[] {
	const span = hi - lo || Math.abs(hi) || 1;
	const raw = span / count;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
	const out: number[] = [];
	for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
	return out;
}

const tickText = (v: number) => String(Number(v.toPrecision(6)));

export function renderPlotSvg(data: PlotData, fontPx: number): string {
	const { spec, lines, marks } = data;
	const small = Math.round(fontPx * 0.8);
	const [x0, x1] = spec.x.range;
	let [y0, y1] = spec.y.range ?? [Infinity, -Infinity];
	if (!spec.y.range) {
		for (const l of lines) for (const v of l.y) (y0 = Math.min(y0, v)), (y1 = Math.max(y1, v));
		for (const m of marks) if (m.axis === "y") (y0 = Math.min(y0, m.at as number)), (y1 = Math.max(y1, m.at as number));
		if (lines.some((l) => l.style === "stems")) (y0 = Math.min(y0, 0)), (y1 = Math.max(y1, 0));
		const pad = (y1 - y0 || Math.abs(y1) || 1) * 0.08;
		y0 -= pad;
		y1 += pad;
	}
	const yTicks = niceTicks(y0, y1, 5);
	const xTicks = niceTicks(x0, x1, 6);
	const yTickLabels = yTicks.map((v) => measure(tickText(v), small));
	const left = Math.max(...yTickLabels.map((l) => l.w)) + 12;
	const yAxis = measure(spec.y.label !== undefined ? labelHtml(spec.y.label) : mathHtml(identLatex(spec.y.name)), fontPx);
	const xAxis = measure(spec.x.label !== undefined ? labelHtml(spec.x.label) : mathHtml(identLatex(spec.x.name)), fontPx);
	const top = yAxis.h + 8;
	const bottom = small + 14;
	const right = xAxis.w + 14;
	const pw = W - left - right;
	const ph = H - top - bottom;
	const sx = (v: number) => left + ((v - x0) / (x1 - x0)) * pw;
	const sy = (v: number) => top + ph - ((v - y0) / (y1 - y0)) * ph;
	const clipId = `lh-plot-${Math.random().toString(36).slice(2, 9)}`;
	const parts: string[] = [];

	// grid, ticks, axes
	for (const v of xTicks) parts.push(`<line x1="${sx(v).toFixed(1)}" x2="${sx(v).toFixed(1)}" y1="${top}" y2="${top + ph}" stroke="currentColor" stroke-opacity="0.1"/>`);
	yTicks.forEach((v, i) => {
		parts.push(`<line x1="${left}" x2="${left + pw}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}" stroke="currentColor" stroke-opacity="0.1"/>`);
		const l = yTickLabels[i]!;
		parts.push(labelSvg(l, left - l.w - 6, sy(v) - l.h / 2, small, "opacity:0.75"));
	});
	for (const v of xTicks) {
		const l = measure(tickText(v), small);
		parts.push(labelSvg(l, sx(v) - l.w / 2, top + ph + 4, small, "opacity:0.75"));
	}
	const axisY = y0 <= 0 && y1 >= 0 ? sy(0) : top + ph;
	const axisX = x0 <= 0 && x1 >= 0 ? sx(0) : left;
	parts.push(`<path d="M${left} ${axisY.toFixed(1)}H${left + pw + 8}" stroke="currentColor" stroke-width="1.2" fill="none" marker-end="url(#${clipId}-a)"/>`);
	parts.push(`<path d="M${axisX.toFixed(1)} ${top + ph}V${top - 6}" stroke="currentColor" stroke-width="1.2" fill="none" marker-end="url(#${clipId}-a)"/>`);
	parts.push(labelSvg(xAxis, left + pw + 10, axisY - xAxis.h / 2, fontPx));
	parts.push(labelSvg(yAxis, axisX + 6, top - yAxis.h - 4, fontPx));

	// curves
	let colour = 0;
	const legend: Array<{ label: string; color: string; stems: boolean }> = [];
	for (const l of lines) {
		if (l.style === "faint") {
			parts.push(`<path clip-path="url(#${clipId})" d="M${l.x.map((x, i) => `${sx(x).toFixed(1)} ${sy(l.y[i]!).toFixed(1)}`).join("L")}" fill="none" stroke="currentColor" stroke-opacity="0.3" stroke-dasharray="3 3"/>`);
			continue;
		}
		const color = PALETTE[colour++ % PALETTE.length]!;
		if (l.style === "stems") {
			for (let i = 0; i < l.x.length; i++) {
				const x = sx(l.x[i]!).toFixed(1);
				parts.push(`<line clip-path="url(#${clipId})" x1="${x}" x2="${x}" y1="${axisY.toFixed(1)}" y2="${sy(l.y[i]!).toFixed(1)}" stroke="${color}" stroke-width="1.4"/>`);
				parts.push(`<circle clip-path="url(#${clipId})" cx="${x}" cy="${sy(l.y[i]!).toFixed(1)}" r="3" fill="${color}"/>`);
			}
		} else {
			parts.push(`<path clip-path="url(#${clipId})" d="M${l.x.map((x, i) => `${sx(x).toFixed(1)} ${sy(l.y[i]!).toFixed(1)}`).join("L")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`);
		}
		if (l.label !== undefined) legend.push({ label: l.label, color, stems: l.style === "stems" });
	}

	// markers
	for (const m of marks) {
		const lab = m.label !== undefined ? measure(labelHtml(m.label), small) : null;
		if (m.axis === "x") {
			const x = sx(m.at as number);
			parts.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${top + ph}" stroke="currentColor" stroke-opacity="0.6" stroke-dasharray="4 3"/>`);
			if (lab) parts.push(labelSvg(lab, x + 4, top + 2, small));
		} else if (m.axis === "y") {
			const y = sy(m.at as number);
			parts.push(`<line x1="${left}" x2="${left + pw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-opacity="0.6" stroke-dasharray="4 3"/>`);
			if (lab) parts.push(labelSvg(lab, left + pw - lab.w - 2, y - lab.h - 1, small));
		} else {
			const [px, py] = m.at as [number, number];
			parts.push(`<circle cx="${sx(px).toFixed(1)}" cy="${sy(py).toFixed(1)}" r="3.5" fill="currentColor"/>`);
			if (lab) parts.push(labelSvg(lab, sx(px) + 6, sy(py) - lab.h - 2, small));
		}
	}

	// legend: a row under the plot — it never covers the data
	let totalH = H;
	if (legend.length > 0) {
		const items = legend.map((g) => ({ ...g, l: measure(labelHtml(g.label), small) }));
		const rowH = Math.max(...items.map((i) => i.l.h)) + 4;
		let x = left;
		let y = H;
		for (const i of items) {
			const w = 24 + i.l.w + 16;
			if (x + w > W - 8 && x > left) {
				x = left;
				y += rowH;
			}
			const cy = y + rowH / 2;
			parts.push(
				i.stems
					? `<circle cx="${x + 9}" cy="${cy.toFixed(1)}" r="3" fill="${i.color}"/>`
					: `<line x1="${x}" x2="${x + 18}" y1="${cy.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${i.color}" stroke-width="2"/>`,
			);
			parts.push(labelSvg(i.l, x + 24, cy - i.l.h / 2, small));
			x += w;
		}
		totalH = y + rowH + 4;
	}

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${totalH}" width="${W}" height="${totalH}" role="img" aria-label="Plot">` +
		`<defs><clipPath id="${clipId}"><rect x="${left}" y="${top}" width="${pw}" height="${ph}"/></clipPath>` +
		`<marker id="${clipId}-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>` +
		parts.join("") +
		`</svg>`
	);
}
