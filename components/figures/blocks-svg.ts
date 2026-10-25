import ELK, { type ElkExtendedEdge, type ElkNode, type ElkPoint } from "elkjs/lib/elk.bundled.js";
import { identLatex, toLatex, type Block, type BlockDiagram, type Expr } from "@/src/core";
import { labelHtml, labelSvg, mathHtml, measure, type Label } from "@/components/figures/figure-label";

/**
 * A ```blocks diagram as svg (figures phase 1, owner 2026-10-26) —
 * TEXTBOOK style: every block a plain box with its expression, sums as
 * circles with a sign at each input, saturation and dead zone as their
 * characteristic curve, signal names on the wires, branch dots where a
 * signal splits. Layout: ELK layered, left → right, orthogonal wires;
 * feedback enters a sum from below.
 *
 * Strokes and text use currentColor — the figure follows the theme.
 */

const elk = new ELK();
const SUM_D = 22;
const PAD_X = 12;
const PAD_Y = 8;
const ICON = { w: 46, h: 34 };

interface NodeInfo {
	block?: Block;
	/** Output terminal of this signal. */
	terminal?: string;
	label?: Label;
}

/** The LaTeX inside a block's box. */
function blockLatex(b: Block): string | null {
	const tex = (e: Expr) => toLatex(e);
	switch (b.kind) {
		case "gain":
			return tex(b.k);
		case "int":
			return "\\frac{1}{s}";
		case "deriv":
			return "s";
		case "tf":
			return tex(b.h);
		case "delay":
			return `e^{-${tex(b.T)}\\,s}`;
		case "pid": {
			const g = b.gains;
			if (b.form === "standard") {
				const inner = ["1", ...(g.T_i ? [`\\frac{1}{${tex(g.T_i)}\\,s}`] : []), ...(g.T_d ? [`${tex(g.T_d)}\\,s`] : [])];
				return `${tex(g.K_p!)}\\left(${inner.join(" + ")}\\right)`;
			}
			return [...(g.K_p ? [tex(g.K_p)] : []), ...(g.K_i ? [`\\frac{${tex(g.K_i)}}{s}`] : []), ...(g.K_d ? [`${tex(g.K_d)}\\,s`] : [])].join(" + ");
		}
		default:
			return null;
	}
}

/** The characteristic-curve icon of a static nonlinearity. */
function iconSvg(kind: "sat" | "deadzone", x: number, y: number): string {
	const cx = x + ICON.w / 2;
	const cy = y + ICON.h / 2;
	const axes = `<path d="M${x + 6} ${cy}H${x + ICON.w - 6}M${cx} ${y + 5}V${y + ICON.h - 5}" stroke="currentColor" stroke-opacity="0.35" stroke-width="1" fill="none"/>`;
	const curve =
		kind === "sat"
			? `M${x + 7} ${cy + 9}H${cx - 7}L${cx + 7} ${cy - 9}H${x + ICON.w - 7}`
			: `M${x + 7} ${cy + 9}L${cx - 6} ${cy}H${cx + 6}L${x + ICON.w - 7} ${cy - 9}`;
	return `${axes}<path d="${curve}" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>`;
}

const pts = (e: ElkExtendedEdge): ElkPoint[] =>
	(e.sections ?? []).flatMap((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]);

export async function renderBlocksSvg(d: BlockDiagram, fontPx: number): Promise<string> {
	const info = new Map<string, NodeInfo>();
	const children: ElkNode[] = [];
	const edges: ElkExtendedEdge[] = [];
	const small = Math.round(fontPx * 0.9);

	for (const b of d.blocks) {
		const id = `n_${b.out}`;
		if (b.kind === "input") {
			const label = measure(b.label !== undefined ? labelHtml(b.label) : mathHtml(identLatex(b.out)), fontPx);
			info.set(id, { block: b, label });
			children.push({
				id,
				width: label.w,
				height: label.h,
				ports: [{ id: `${id}.out`, width: 0, height: 0, layoutOptions: { "elk.port.side": "EAST" } }],
				layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
			});
			continue;
		}
		if (b.kind === "sum") {
			// feedback = a term from a later line (the order the layout keeps):
			// it enters from below; the first forward term from the left, the
			// rest from above
			const here = d.blocks.indexOf(b);
			const later = (sig: string) => d.blocks.findIndex((x) => x.out === sig) >= here;
			let forward = 0;
			const ports = b.terms.map((t, i) => {
				const side = later(t.sig) ? "SOUTH" : forward++ === 0 ? "WEST" : "NORTH";
				const [x, y] = side === "WEST" ? [0, SUM_D / 2] : side === "SOUTH" ? [SUM_D / 2, SUM_D] : [SUM_D / 2, 0];
				return { id: `${id}.in${i}`, width: 0, height: 0, x, y, layoutOptions: { "elk.port.side": side } };
			});
			info.set(id, { block: b });
			children.push({
				id,
				width: SUM_D,
				height: SUM_D,
				ports: [...ports, { id: `${id}.out`, width: 0, height: 0, x: SUM_D, y: SUM_D / 2, layoutOptions: { "elk.port.side": "EAST" } }],
				layoutOptions: { "elk.portConstraints": "FIXED_POS" },
			});
			b.terms.forEach((t, i) => edges.push({ id: `e_${t.sig}_${id}_${i}`, sources: [`n_${t.sig}.out`], targets: [`${id}.in${i}`] }));
			continue;
		}
		const tex = blockLatex(b);
		const label = b.label !== undefined ? measure(labelHtml(b.label), fontPx) : tex !== null ? measure(mathHtml(tex), fontPx) : null;
		const w = label ? Math.max(label.w + 2 * PAD_X, 40) : ICON.w;
		const h = label ? Math.max(label.h + 2 * PAD_Y, 34) : ICON.h;
		info.set(id, { block: b, ...(label ? { label } : {}) });
		children.push({
			id,
			width: w,
			height: h,
			ports: [
				{ id: `${id}.in`, width: 0, height: 0, x: 0, y: h / 2, layoutOptions: { "elk.port.side": "WEST" } },
				{ id: `${id}.out`, width: 0, height: 0, x: w, y: h / 2, layoutOptions: { "elk.port.side": "EAST" } },
			],
			layoutOptions: { "elk.portConstraints": "FIXED_POS" },
		});
		edges.push({ id: `e_${(b as { inSig: string }).inSig}_${id}`, sources: [`n_${(b as { inSig: string }).inSig}.out`], targets: [`${id}.in`] });
	}
	for (const out of d.outputs) {
		const id = `o_${out}`;
		info.set(id, { terminal: out });
		children.push({ id, width: 1, height: 1, ports: [{ id: `${id}.in`, width: 0, height: 0, layoutOptions: { "elk.port.side": "WEST" } }], layoutOptions: { "elk.portConstraints": "FIXED_SIDE" } });
		edges.push({ id: `e_${out}_${id}`, sources: [`n_${out}.out`], targets: [`${id}.in`] });
	}

	// one wire label per signal (inputs at their start, outputs at their end), on
	// the first wire leaving its block
	const labelled = new Set([...d.blocks.filter((b) => b.kind === "input").map((b) => b.out), ...d.outputs]);
	const wireLabels = new Map<string, Label>();
	for (const e of edges) {
		const sig = e.sources[0]!.slice(2, -4);
		if (labelled.has(sig)) continue;
		labelled.add(sig);
		const l = measure(mathHtml(identLatex(sig)), small);
		wireLabels.set(e.id, l);
		e.labels = [{ id: `${e.id}.label`, text: sig, width: l.w, height: l.h }];
	}

	const root: ElkNode = {
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "RIGHT",
			"elk.edgeRouting": "ORTHOGONAL",
			"elk.layered.mergeEdges": "true",
			"elk.layered.spacing.nodeNodeBetweenLayers": "40",
			// the description is written along the signal flow: an edge back to
			// an earlier line is feedback (drawn returning underneath)
			"elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
			"elk.spacing.nodeNode": "26",
			"elk.spacing.edgeNode": "14",
			"elk.spacing.edgeEdge": "12",
			"elk.layered.spacing.edgeNodeBetweenLayers": "14",
			"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
			"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
			"elk.edgeLabels.placement": "CENTER",
			"elk.padding": "[top=10,left=10,bottom=10,right=10]",
		},
		children,
		edges,
	};
	const graph = await elk.layout(root);

	const parts: string[] = [];
	// per-render marker id: the overlay copy must never borrow the inline one
	const arrowId = `lh-arrow-${Math.random().toString(36).slice(2, 9)}`;
	const M = 6;
	const W = (graph.width ?? 0) + 2 * M;
	const H = (graph.height ?? 0) + 2 * M;
	const at = (n: number) => (n + M).toFixed(1);

	// wires
	const junctions = new Map<string, ElkPoint>();
	for (const e of graph.edges ?? []) {
		const p = pts(e);
		if (p.length < 2) continue;
		parts.push(`<path d="M${p.map((q) => `${at(q.x)} ${at(q.y)}`).join("L")}" fill="none" stroke="currentColor" stroke-width="1.3" marker-end="url(#${arrowId})"/>`);
		for (const j of e.junctionPoints ?? []) junctions.set(`${Math.round(j.x)},${Math.round(j.y)}`, j);
		for (const l of e.labels ?? []) {
			const lab = wireLabels.get(e.id);
			if (lab) parts.push(labelSvg(lab, l.x! + M, l.y! + M - 2, small));
		}
	}
	for (const j of junctions.values()) parts.push(`<circle cx="${at(j.x)}" cy="${at(j.y)}" r="2.6" fill="currentColor"/>`);

	// blocks
	for (const n of graph.children ?? []) {
		const ni = info.get(n.id)!;
		const x = n.x! + M;
		const y = n.y! + M;
		if (ni.terminal) {
			const l = measure(mathHtml(identLatex(ni.terminal)), fontPx);
			parts.push(labelSvg(l, x + 4, y - l.h / 2, fontPx));
			continue;
		}
		const b = ni.block!;
		if (b.kind === "input") {
			parts.push(labelSvg(ni.label!, x, y, fontPx));
			continue;
		}
		if (b.kind === "sum") {
			const cx = x + SUM_D / 2;
			const cy = y + SUM_D / 2;
			parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${SUM_D / 2}" fill="none" stroke="currentColor" stroke-width="1.4"/>`);
			b.terms.forEach((t, i) => {
				const port = n.ports!.find((p) => p.id === `${n.id}.in${i}`)!;
				const px = x + port.x!;
				const py = y + port.y!;
				const side = px <= x + 1 ? "W" : py >= y + SUM_D - 1 ? "S" : "N";
				const [sx, sy] = side === "W" ? [px - 10, py - 7] : side === "S" ? [px + 8, py + 9] : [px + 8, py - 3];
				parts.push(`<text x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" font-size="${small}" text-anchor="middle" fill="currentColor">${t.sign > 0 ? "+" : "−"}</text>`);
			});
			continue;
		}
		parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${n.width}" height="${n.height}" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/>`);
		if (ni.label) parts.push(labelSvg(ni.label, x + (n.width! - ni.label.w) / 2, y + (n.height! - ni.label.h) / 2, fontPx));
		else if (b.kind === "sat" || b.kind === "deadzone") parts.push(iconSvg(b.kind, x, y));
	}

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" width="${W.toFixed(0)}" height="${H.toFixed(0)}" role="img" aria-label="Block diagram">` +
		`<defs><marker id="${arrowId}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>` +
		parts.join("") +
		`</svg>`
	);
}
