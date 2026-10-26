import ELK, { type ElkExtendedEdge, type ElkNode, type ElkPoint } from "elkjs/lib/elk.bundled.js";
import { identLatex, isGate, logicInputs, type LogicDiagram, type LogicElement } from "@/src/core";
import { labelHtml, labelSvg, mathHtml, measure, type Label } from "@/components/figures/figure-label";

/**
 * A ```logic diagram as svg (figures phase 3, owner 2026-10-26): the
 * distinctive gate shapes (AND, OR, XOR, NOT/BUF, with inversion bubbles
 * for NAND/NOR/XNOR/NOT), flip-flops and latches as boxes with D/EN/S/R
 * and Q/Q̄ pins (a clock triangle on the dff), signal names on the wires.
 * Layout: ELK layered, left → right, the line order as the forward path
 * — the same approach as block diagrams.
 */

const elk = new ELK();
const GATE_W = 40;
const BUBBLE = 7;
const STORE = { w: 56, h: 60 };
const STROKE = `stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"`;

const inverting = (k: string) => k === "nand" || k === "nor" || k === "xnor" || k === "not";
const gateH = (n: number) => Math.max(30, 12 * n + 6);
/** The x of an OR/XOR back curve at port height y (quadratic Bézier). */
const backX = (x: number, y: number, top: number, h: number, depth: number) => {
	const t = (y - top) / h;
	return x + 2 * depth * t * (1 - t);
};

function gateBody(e: Extract<LogicElement, { kind: "and" | "or" | "nand" | "nor" | "xor" | "xnor" | "not" | "buf" }>, x: number, y: number, h: number, ports: number[]): string {
	const w = GATE_W;
	const my = y + h / 2;
	const parts: string[] = [];
	const k = e.kind;
	if (k === "and" || k === "nand") {
		parts.push(`<path d="M${x} ${y}H${x + w - h / 2}A${h / 2} ${h / 2} 0 0 1 ${x + w - h / 2} ${y + h}H${x}Z" ${STROKE}/>`);
	} else if (k === "not" || k === "buf") {
		parts.push(`<path d="M${x} ${y + 2}L${x + w - 6} ${my}L${x} ${y + h - 2}Z" ${STROKE}/>`);
	} else {
		const off = k === "xor" || k === "xnor" ? 6 : 0;
		const bx = x + off;
		const depth = 9;
		parts.push(`<path d="M${bx} ${y}Q${bx + depth} ${my} ${bx} ${y + h}Q${x + w * 0.7} ${y + h} ${x + w} ${my}Q${x + w * 0.7} ${y} ${bx} ${y}Z" ${STROKE}/>`);
		if (off) parts.push(`<path d="M${x} ${y}Q${x + depth} ${my} ${x} ${y + h}" ${STROKE}/>`);
		// input stubs reach the curved back
		for (const py of ports) parts.push(`<path d="M${x} ${py}H${backX(bx, py, y, h, depth).toFixed(1)}" ${STROKE}/>`);
	}
	const tip = k === "not" || k === "buf" ? x + w - 6 : x + w;
	if (inverting(k)) parts.push(`<circle cx="${tip + BUBBLE / 2}" cy="${my}" r="${BUBBLE / 2}" ${STROKE}/>`);
	return parts.join("");
}

function pinText(text: string, x: number, y: number, anchor: "start" | "end", size: number, over = false): string {
	const t = `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" dominant-baseline="middle" fill="currentColor">${text}</text>`;
	if (!over) return t;
	const w = size * 0.62;
	const x0 = anchor === "end" ? x - w : x;
	return t + `<path d="M${x0} ${y - size * 0.62}h${w}" stroke="currentColor" stroke-width="1"/>`;
}

const pts = (e: ElkExtendedEdge): ElkPoint[] => (e.sections ?? []).flatMap((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]);

export async function renderLogicSvg(d: LogicDiagram, fontPx: number): Promise<string> {
	const small = Math.round(fontPx * 0.8);
	const children: ElkNode[] = [];
	const edges: ElkExtendedEdge[] = [];
	const info = new Map<string, { el?: LogicElement; terminal?: string; label?: Label; h?: number }>();
	const port = (id: string, x: number, y: number, side: string) => ({ id, width: 0, height: 0, x, y, layoutOptions: { "elk.port.side": side } });
	// the node (and port) a signal leaves from — a store's inverted output has its own port
	const source = new Map<string, string>();

	for (const e of d.elements) {
		const id = `n_${e.out}`;
		if (e.kind === "input") {
			const label = measure(e.label !== undefined ? labelHtml(e.label) : mathHtml(identLatex(e.out)), fontPx);
			info.set(id, { el: e, label });
			children.push({ id, width: label.w, height: label.h, ports: [port(`${id}.out`, label.w, label.h / 2, "EAST")], layoutOptions: { "elk.portConstraints": "FIXED_POS" } });
			source.set(e.out, `${id}.out`);
			continue;
		}
		if (isGate(e.kind)) {
			const n = logicInputs(e).length;
			const h = gateH(n);
			const w = GATE_W + (inverting(e.kind) ? BUBBLE : 0) - (e.kind === "not" || e.kind === "buf" ? 6 : 0);
			const ys = logicInputs(e).map((_, i) => (n === 1 ? h / 2 : 6 + ((h - 12) * i) / (n - 1)));
			info.set(id, { el: e, h });
			children.push({
				id,
				width: w,
				height: h,
				ports: [...ys.map((y, i) => port(`${id}.in${i}`, 0, y, "WEST")), port(`${id}.out`, w, h / 2, "EAST")],
				layoutOptions: { "elk.portConstraints": "FIXED_POS" },
			});
			source.set(e.out, `${id}.out`);
			logicInputs(e).forEach((sig, i) => edges.push({ id: `e_${sig}_${id}_${i}`, sources: [sig], targets: [`${id}.in${i}`] }));
			continue;
		}
		// a flip-flop or latch
		const outN = "outN" in e ? e.outN : undefined;
		info.set(id, { el: e });
		children.push({
			id,
			width: STORE.w,
			height: STORE.h,
			ports: [port(`${id}.in0`, 0, 16, "WEST"), port(`${id}.in1`, 0, 44, "WEST"), port(`${id}.out`, STORE.w, 16, "EAST"), ...(outN ? [port(`${id}.outN`, STORE.w, 44, "EAST")] : [])],
			layoutOptions: { "elk.portConstraints": "FIXED_POS" },
		});
		source.set(e.out, `${id}.out`);
		if (outN) source.set(outN, `${id}.outN`);
		logicInputs(e).forEach((sig, i) => edges.push({ id: `e_${sig}_${id}_${i}`, sources: [sig], targets: [`${id}.in${i}`] }));
	}
	for (const out of d.outputs) {
		const id = `o_${out}`;
		info.set(id, { terminal: out });
		children.push({ id, width: 1, height: 1, ports: [port(`${id}.in`, 0, 0.5, "WEST")], layoutOptions: { "elk.portConstraints": "FIXED_POS" } });
		edges.push({ id: `e_${out}_${id}`, sources: [out], targets: [`${id}.in`] });
	}
	// remember each wire's signal, then point it at its source port
	const signalOf = new Map(edges.map((e) => [e.id, e.sources[0]!]));
	for (const e of edges) e.sources = [source.get(e.sources[0]!)!];

	// one wire label per internal signal, on its first wire
	const labelled = new Set([...d.elements.filter((e) => e.kind === "input").map((e) => e.out), ...d.outputs]);
	const wireLabels = new Map<string, Label>();
	for (const e of edges) {
		const sig = signalOf.get(e.id)!;
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
			"elk.layered.spacing.nodeNodeBetweenLayers": "36",
			"elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
			"elk.spacing.nodeNode": "22",
			"elk.spacing.edgeNode": "12",
			"elk.spacing.edgeEdge": "10",
			"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
			"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
			"elk.edgeLabels.placement": "CENTER",
			"elk.padding": "[top=10,left=10,bottom=10,right=10]",
		},
		children,
		edges,
	};
	const graph = await elk.layout(root);
	const M = 6;
	const at = (n: number) => (n + M).toFixed(1);
	const parts: string[] = [];
	const junctions = new Map<string, ElkPoint>();
	for (const e of graph.edges ?? []) {
		const p = pts(e);
		if (p.length < 2) continue;
		parts.push(`<path d="M${p.map((q) => `${at(q.x)} ${at(q.y)}`).join("L")}" ${STROKE}/>`);
		for (const j of e.junctionPoints ?? []) junctions.set(`${Math.round(j.x)},${Math.round(j.y)}`, j);
		const lab = wireLabels.get(e.id);
		for (const l of e.labels ?? []) if (lab) parts.push(labelSvg(lab, l.x! + M, l.y! + M - 2, small));
	}
	for (const j of junctions.values()) parts.push(`<circle cx="${at(j.x)}" cy="${at(j.y)}" r="2.6" fill="currentColor"/>`);

	for (const n of graph.children ?? []) {
		const ni = info.get(n.id)!;
		const x = n.x! + M;
		const y = n.y! + M;
		if (ni.terminal) {
			const l = measure(mathHtml(identLatex(ni.terminal)), fontPx);
			parts.push(labelSvg(l, x + 4, y - l.h / 2, fontPx));
			continue;
		}
		const e = ni.el!;
		if (e.kind === "input") {
			parts.push(labelSvg(ni.label!, x, y, fontPx));
			continue;
		}
		if (isGate(e.kind)) {
			const ys = (n.ports ?? []).filter((p) => p.id.includes(".in")).map((p) => y + p.y!);
			parts.push(gateBody(e as Parameters<typeof gateBody>[0], x, y, ni.h!, ys));
			continue;
		}
		// flip-flop / latch box
		parts.push(`<rect x="${x}" y="${y}" width="${STORE.w}" height="${STORE.h}" rx="2" ${STROKE}/>`);
		const [a, b] = e.kind === "dff" ? ["D", ""] : e.kind === "dlatch" ? ["D", "EN"] : ["S", "R"];
		parts.push(pinText(a, x + 5, y + 16, "start", small));
		if (e.kind === "dff") parts.push(`<path d="M${x} ${y + 38}L${x + 8} ${y + 44}L${x} ${y + 50}" ${STROKE}/>`);
		else parts.push(pinText(b, x + 5, y + 44, "start", small));
		parts.push(pinText("Q", x + STORE.w - 5, y + 16, "end", small));
		if ("outN" in e && e.outN) parts.push(pinText("Q", x + STORE.w - 5, y + 44, "end", small, true));
	}

	const W = (graph.width ?? 0) + 2 * M;
	const H = (graph.height ?? 0) + 2 * M;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" width="${W.toFixed(0)}" height="${H.toFixed(0)}" role="img" aria-label="Logic diagram">` +
		parts.join("") +
		`</svg>`
	);
}
