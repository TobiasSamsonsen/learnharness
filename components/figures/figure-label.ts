import katex from "katex";

/**
 * Figure labels (figures phase 1): KaTeX HTML measured in the live
 * document, so a block's box and the layout fit its formula exactly.
 * Rendered into the figure svg as a foreignObject — the page's KaTeX CSS
 * styles it, and `color: inherit` keeps it on the theme.
 */

export interface Label {
	html: string;
	w: number;
	h: number;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A model-written label: text with optional $…$ math. */
export function labelHtml(text: string): string {
	return text
		.split(/(\$[^$]+\$)/g)
		.map((part) => (/^\$[^$]+\$$/.test(part) ? katex.renderToString(part.slice(1, -1), { throwOnError: false }) : escapeHtml(part)))
		.join("");
}

export function mathHtml(latex: string): string {
	return katex.renderToString(latex, { throwOnError: false });
}

let probe: HTMLDivElement | null = null;

/** Measure rendered HTML at a font size (px). */
export function measure(html: string, fontPx: number): Label {
	probe ??= Object.assign(document.createElement("div"), { ariaHidden: "true" });
	if (!probe.isConnected) {
		probe.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden;white-space:nowrap;display:inline-block;line-height:1.2";
		document.body.appendChild(probe);
	}
	probe.style.fontSize = `${fontPx}px`;
	probe.innerHTML = html;
	const r = probe.getBoundingClientRect();
	return { html, w: Math.ceil(r.width) + 1, h: Math.ceil(r.height) };
}

/** A label placed as a foreignObject with its top-left at (x, y). */
export function labelSvg(l: Label, x: number, y: number, fontPx: number, extraStyle = ""): string {
	return (
		// overflow visible: a label a little wider than measured is never clipped
		`<foreignObject x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${l.w}" height="${l.h}" overflow="visible">` +
		`<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${fontPx}px;line-height:1.2;white-space:nowrap;color:inherit;${extraStyle}">${l.html}</div>` +
		`</foreignObject>`
	);
}

/** The same svg with a fixed dark ink, for the white overlay stage
 *  (session-overlay figure mode inverts it back for the dark theme). */
export function withInk(svg: string, ink = "#111111"): string {
	return svg.replace(/^<svg\b/, `<svg style="color:${ink}"`);
}
