import { elementUnit, formatSI, GROUND, identLatex, layoutCircuit, type Circuit, type Element, type Point } from "@/src/core";
import { labelHtml, labelSvg, mathHtml, measure, type Label } from "@/components/figures/figure-label";

/**
 * A ```circuit as svg (figures phase 2, owner 2026-10-26) — European
 * (IEC) symbols on the grid core/figures/circuit.ts lays out from the
 * directions: box resistors, plate capacitors, humped inductors, circle
 * sources with +/− (current sources with an arrow), diodes, switches in
 * their t < 0 position, diamond dependent sources, open terminals,
 * ground symbols at every ground connection, dots at junctions.
 *
 * Each symbol is drawn along +x and rotated into place; signs and labels
 * are placed upright beside it. currentColor throughout.
 */

const U = 100;
const STROKE = `stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"`;

/** Half the symbol's length along its axis (the leads fill the rest). */
const HALF: Partial<Record<Element["kind"], number>> = { R: 16, C: 4, L: 16, V: 13, I: 13, D: 8, S: 11, E: 13, G: 13 };

/** The symbol body in local coordinates (axis = +x, centred on 0). */
function body(el: Element): string {
	switch (el.kind) {
		case "R":
			return `<rect x="-16" y="-6.5" width="32" height="13" ${STROKE}/>`;
		case "C":
			return `<path d="M-4 -12V12M4 -12V12" ${STROKE} stroke-width="2"/>`;
		case "L":
			return `<path d="M-16 0a4 4 0 0 1 8 0a4 4 0 0 1 8 0a4 4 0 0 1 8 0a4 4 0 0 1 8 0" ${STROKE}/>`;
		case "V":
			return `<circle r="13" ${STROKE}/>`;
		case "I":
			return `<circle r="13" ${STROKE}/><path d="M-7 0H6M2 -4L7 0L2 4" ${STROKE}/>`;
		case "E":
			return `<path d="M-13 0L0 -13L13 0L0 13Z" ${STROKE}/>`;
		case "G":
			return `<path d="M-13 0L0 -13L13 0L0 13Z" ${STROKE}/><path d="M-7 0H6M2 -4L7 0L2 4" ${STROKE}/>`;
		case "D": {
			const led = el.led ? `<path d="M0 -12l5 -6M3 -18h2v2M5 -11l5 -6M8 -17h2v2" ${STROKE} stroke-width="1.2"/>` : "";
			return `<path d="M-8 -8L-8 8L8 0Z" ${STROKE} fill="currentColor" fill-opacity="0.15"/><path d="M8 -8V8" ${STROKE}/>${led}`;
		}
		case "S": {
			const before = el.switch!.before;
			const lever = before ? `<path d="M-11 0H11" ${STROKE}/>` : `<path d="M-11 0L9 -11" ${STROKE}/>`;
			const motion = el.switch!.before !== el.switch!.after ? `<path d="M${before ? "4 -3" : "6 -12"}a10 10 0 0 ${before ? "0" : "1"} ${before ? "4 -8" : "3 9"}" ${STROKE} stroke-width="1" marker-end="url(#ARROW)"/>` : "";
			return `<circle cx="-11" r="2.2" fill="currentColor"/><circle cx="11" r="2.2" fill="currentColor"/>${lever}${motion}`;
		}
		default:
			return "";
	}
}

/**
 * A BJT or MOSFET in its frame: x along collector/drain (−L/2) →
 * emitter/source (+L/2), y toward the base/gate lead (which ends at y =
 * `toBase`). IEC 60617 shapes: the BJT's base bar with collector and
 * emitter diagonals in an envelope circle, the emitter arrow out (npn) or
 * in (pnp); the enhancement MOSFET's gate plate over a broken channel, the
 * body tied to the source with its arrow in (nmos) or out (pmos).
 */
function transistorBody(el: Element, L: number, toBase: number, arrowId: string): string {
	const h = L / 2;
	if (el.kind === "Q") {
		const npn = el.model === "npn";
		const arrow = npn ? `M7 12L18 0` : `M18 0L7 12`;
		return (
			`<circle cx="0" cy="8" r="23" ${STROKE}/>` +
			`<path d="M-14 12H14M0 12V${toBase}" ${STROKE} stroke-width="2"/>` +
			`<path d="M-${h} 0H-18L-7 12M18 0H${h}" ${STROKE}/>` +
			`<path d="${arrow}" ${STROKE} marker-end="url(#${arrowId})"/>`
		);
	}
	const nmos = el.model === "nmos";
	return (
		`<path d="M-14 19H14M0 19V${toBase}" ${STROKE} stroke-width="2"/>` +
		`<path d="M-14 12H-6M-3 12H3M6 12H14" ${STROKE} stroke-width="2.4"/>` +
		`<path d="M-${h} 0H-10V12M10 12V0H${h}M0 0H10" ${STROKE}/>` +
		`<path d="${nmos ? "M0 0V10" : "M0 12V2"}" ${STROKE} marker-end="url(#${arrowId})"/>`
	);
}

/** An op-amp in its frame: x from the input side (0) to the output (L),
 *  y toward the − input (at y = `inputs`; + at −`inputs`). */
function opampBody(L: number, inputs: number): string {
	const back = 14;
	const tip = L - 14;
	const half = inputs + 14;
	return (
		`<path d="M${back} ${-half}L${tip} 0L${back} ${half}Z" ${STROKE}/>` +
		`<path d="M0 ${inputs}H${back}M0 ${-inputs}H${back}M${tip} 0H${L}" ${STROKE}/>`
	);
}

/** "R1" → R_{1}, "Vs" → V_{s}, "Rload" → R_{load}. */
function nameLatex(name: string): string {
	const m = /^([A-Za-z])([A-Za-z0-9_]*)$/.exec(name);
	return m && m[2] ? `${m[1]}_{${m[2].replace(/_/g, "")}}` : identLatex(name);
}

const at = (p: Point) => ({ x: p.x * U, y: p.y * U });

export function renderCircuitSvg(c: Circuit, fontPx: number): string {
	const { nodes, placed } = layoutCircuit(c);
	const small = Math.round(fontPx * 0.85);
	const arrowId = `lh-ca-${Math.random().toString(36).slice(2, 9)}`;
	const parts: string[] = [];
	const labels: string[] = [];
	const pts: Point[] = [];
	const grounds: Point[] = [];
	const degree = new Map<string, number>();
	const place = (l: Label, cx: number, cy: number) => {
		labels.push(labelSvg(l, cx - l.w / 2, cy - l.h / 2, small));
		pts.push({ x: cx - l.w / 2, y: cy - l.h / 2 }, { x: cx + l.w / 2, y: cy + l.h / 2 });
	};

	for (const { el, a: ga, b: gb, c: gc, d: gd } of placed) {
		const A = at(ga);
		const B = at(gb);
		pts.push(A, B);
		if (el.kind === "Q" || el.kind === "M" || el.opamp) {
			// three-terminal parts, drawn in their own frame: x along the main
			// axis, y toward the base/gate (transistor) or the − input (op-amp)
			const C = at(gc!);
			const toward = el.opamp ? at(gd!) : C;
			const origin = el.opamp ? A : { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
			const L = Math.hypot(B.x - A.x, B.y - A.y);
			const ux = (B.x - A.x) / L;
			const uy = (B.y - A.y) / L;
			const sl = Math.hypot(toward.x - origin.x, toward.y - origin.y);
			const sx = (toward.x - origin.x) / sl;
			const sy = (toward.y - origin.y) / sl;
			const local = (x: number, y: number) => ({ x: origin.x + ux * x + sx * y, y: origin.y + uy * x + sy * y });
			const frame = `matrix(${ux.toFixed(4)} ${uy.toFixed(4)} ${sx.toFixed(4)} ${sy.toFixed(4)} ${origin.x.toFixed(1)} ${origin.y.toFixed(1)})`;
			const terminals = el.opamp ? [el.n1, ...el.control!] : [el.n1, el.n2, el.third!];
			for (const n of terminals) if (n !== GROUND) degree.set(n, (degree.get(n) ?? 0) + 1);
			if (el.opamp) {
				const D = at(gd!);
				pts.push(C, D);
				parts.push(`<g transform="${frame}">${opampBody(L, sl)}</g>`);
				// upright signs beside the inputs: − at the top input, + at the other
				const minus = local(24, sl);
				const plus = local(24, -sl);
				parts.push(`<path d="M${(minus.x - 4).toFixed(1)} ${minus.y.toFixed(1)}h8M${(plus.x - 4).toFixed(1)} ${plus.y.toFixed(1)}h8M${plus.x.toFixed(1)} ${(plus.y - 4).toFixed(1)}v8" ${STROKE} stroke-width="1.3"/>`);
				const l = measure(el.label !== undefined ? labelHtml(el.label) : mathHtml(nameLatex(el.name)), small);
				const spot = local(L * 0.42, -(sl + 30));
				place(l, spot.x, spot.y);
				for (const [n, p] of [[el.control![0], C], [el.control![1], D]] as const) if (n === GROUND) grounds.push(p);
			} else {
				pts.push(C);
				parts.push(`<g transform="${frame}">${transistorBody(el, L, sl, arrowId)}</g>`);
				const l = measure(el.label !== undefined ? labelHtml(el.label) : mathHtml(nameLatex(el.name)), small);
				const spot = local(0, -(l.w / 2 + 12));
				place(l, spot.x, spot.y);
				for (const [n, p] of [[el.n1, A], [el.n2, B], [el.third!, C]] as const) if (n === GROUND) grounds.push(p);
			}
			continue;
		}
		for (const n of [el.n1, el.n2]) if (n !== GROUND) degree.set(n, (degree.get(n) ?? 0) + 1);
		// open terminals stay terminals, even on ground
		if (el.n1 === GROUND && el.kind !== "P") grounds.push(A);
		if (el.n2 === GROUND && el.kind !== "P") grounds.push(B);
		const dx = B.x - A.x;
		const dy = B.y - A.y;
		const len = Math.hypot(dx, dy);
		const ux = dx / len;
		const uy = dy / len;
		const mx = (A.x + B.x) / 2;
		const my = (A.y + B.y) / 2;
		const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
		// the label side: above a horizontal element, right of a vertical one
		const [nx, ny] = Math.abs(uy) > 0.5 ? [1, 0] : [0, -1];

		if (el.kind === "P") {
			for (const p of [A, B]) parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/>`);
		} else {
			const h = HALF[el.kind] ?? 0;
			if (h === 0) parts.push(`<path d="M${A.x.toFixed(1)} ${A.y.toFixed(1)}L${B.x.toFixed(1)} ${B.y.toFixed(1)}" ${STROKE}/>`);
			else {
				parts.push(`<path d="M${A.x.toFixed(1)} ${A.y.toFixed(1)}L${(mx - ux * h).toFixed(1)} ${(my - uy * h).toFixed(1)}M${(mx + ux * h).toFixed(1)} ${(my + uy * h).toFixed(1)}L${B.x.toFixed(1)} ${B.y.toFixed(1)}" ${STROKE}/>`);
				parts.push(`<g transform="translate(${mx.toFixed(1)} ${my.toFixed(1)}) rotate(${angle.toFixed(1)})">${body(el).replace(/ARROW/g, arrowId)}</g>`);
			}
		}

		// upright +/− inside voltage sources and VCVS (+ at the first node)
		if (el.kind === "V" || el.kind === "E") {
			const s = 6;
			const [px, py] = [mx - ux * s, my - uy * s];
			const [qx, qy] = [mx + ux * s, my + uy * s];
			parts.push(`<path d="M${(px - 3).toFixed(1)} ${py.toFixed(1)}h6M${px.toFixed(1)} ${(py - 3).toFixed(1)}v6M${(qx - 3).toFixed(1)} ${qy.toFixed(1)}h6" ${STROKE} stroke-width="1.3"/>`);
		}

		// name and value
		const text =
			el.label !== undefined
				? labelHtml(el.label)
				: el.kind === "W"
					? null
					: el.kind === "E" || el.kind === "G"
						? mathHtml(`${nameLatex(el.name)} = ${el.valueText}\\cdot v_{${el.control![0]}${el.control![1] === GROUND ? "" : el.control![1]}}`)
						: el.value !== undefined
							? `${mathHtml(nameLatex(el.name))}&nbsp;${formatSI(el.value, elementUnit(el.kind)).replace(/&/g, "&amp;")}`
							: el.kind === "P"
								? null
								: mathHtml(nameLatex(el.name)) + (el.switch && el.switch.before !== el.switch.after ? `&nbsp;${mathHtml("t = 0")}` : "");
		if (text) {
			const l = measure(text, small);
			const off = (nx !== 0 ? l.w / 2 : l.h / 2) + (HALF[el.kind] ? 17 : 8);
			place(l, mx + nx * off, my + ny * off);
		}

		// voltage annotation on the other side: + at the first node
		if (el.v) {
			const l = measure(labelHtml(`$${el.v}$`), small);
			const off = (nx !== 0 ? l.w / 2 : l.h / 2) + 20;
			place(l, mx - nx * off, my - ny * off);
			const s = (HALF[el.kind] ?? 12) + 8;
			const side = 12;
			const sign = (x: number, y: number, plus: boolean) =>
				parts.push(`<path d="M${(x - 3).toFixed(1)} ${y.toFixed(1)}h6${plus ? `M${x.toFixed(1)} ${(y - 3).toFixed(1)}v6` : ""}" ${STROKE} stroke-width="1.2"/>`);
			sign(mx - ux * s - nx * side, my - uy * s - ny * side, true);
			sign(mx + ux * s - nx * side, my + uy * s - ny * side, false);
		}

		// current arrow on the first lead, pointing first → second node
		if (el.i) {
			const h = HALF[el.kind] ?? 0;
			const t = (len / 2 - h) / 2;
			const cx = A.x + ux * Math.max(10, t);
			const cy = A.y + uy * Math.max(10, t);
			parts.push(`<path d="M${(cx - ux * 5 - uy * 4).toFixed(1)} ${(cy - uy * 5 + ux * 4).toFixed(1)}L${(cx + ux * 3).toFixed(1)} ${(cy + uy * 3).toFixed(1)}L${(cx - ux * 5 + uy * 4).toFixed(1)} ${(cy - uy * 5 - ux * 4).toFixed(1)}Z" fill="currentColor"/>`);
			const l = measure(labelHtml(`$${el.i}$`), small);
			const off = (nx !== 0 ? l.w / 2 : l.h / 2) + 6;
			place(l, cx + nx * off, cy + ny * off);
		}
	}

	// ground symbols: a short stub down, then three bars
	for (const g of grounds) {
		parts.push(`<path d="M${g.x.toFixed(1)} ${g.y.toFixed(1)}v8M${(g.x - 11).toFixed(1)} ${(g.y + 8).toFixed(1)}h22M${(g.x - 7).toFixed(1)} ${(g.y + 12).toFixed(1)}h14M${(g.x - 3).toFixed(1)} ${(g.y + 16).toFixed(1)}h6" ${STROKE}/>`);
		pts.push({ x: g.x - 12, y: g.y }, { x: g.x + 12, y: g.y + 18 });
	}
	// junction dots
	for (const [n, d] of degree) {
		if (d < 3) continue;
		const p = at(nodes.get(n)!);
		parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="currentColor"/>`);
	}
	// labelled nodes
	for (const n of c.shownNodes) {
		const p = at(nodes.get(n)!);
		parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6" fill="currentColor"/>`);
		const l = measure(mathHtml(identLatex(n)), small);
		place(l, p.x - l.w / 2 - 4, p.y - l.h / 2 - 4);
	}

	const minX = Math.min(...pts.map((p) => p.x)) - 10;
	const minY = Math.min(...pts.map((p) => p.y)) - 10;
	const maxX = Math.max(...pts.map((p) => p.x)) + 10;
	const maxY = Math.max(...pts.map((p) => p.y)) + 10;
	const W = maxX - minX;
	const H = maxY - minY;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${W.toFixed(1)} ${H.toFixed(1)}" width="${W.toFixed(0)}" height="${H.toFixed(0)}" role="img" aria-label="Circuit">` +
		`<defs><marker id="${arrowId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>` +
		parts.join("") +
		labels.join("") +
		`</svg>`
	);
}
