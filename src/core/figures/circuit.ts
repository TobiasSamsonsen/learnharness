/**
 * Circuits (figures phase 2, owner 2026-10-26). PURE, browser-safe.
 *
 * The ```circuit fence: an lcapy-style netlist with drawing directions.
 * Each line is one element between two nodes; the direction runs from
 * the first node to the second, so the schematic looks the way the line
 * reads. Node 0 is ground — drawn as a ground symbol wherever it appears,
 * so loops never have to close through it.
 *
 *   V1 a 0 5V; down
 *   R1 a b 2k; right
 *   R2 b 0 3k; down
 *
 * The same netlist SOLVES (modified nodal analysis): DC operating point,
 * equivalent resistance, and first-order (or any linear) transients after
 * a switch moves at t = 0 — so question keys can be checked against it.
 */

import { FigureError, statements, type Statement } from "./lines.ts";
import { METRICS, metric, type Metric } from "./metrics.ts";

export type ElementKind = "R" | "C" | "L" | "V" | "I" | "D" | "S" | "W" | "P" | "E" | "G" | "Q" | "M";
export type Direction = "right" | "left" | "up" | "down";
export type TransistorModel = "npn" | "pnp" | "nmos" | "pmos";
export const TRANSISTOR_MODELS: readonly TransistorModel[] = ["npn", "pnp", "nmos", "pmos"];

export interface Element {
	kind: ElementKind;
	name: string;
	/** The two drawn terminals (first → second along `dir`). Transistors:
	 *  collector/drain → emitter/source. Op-amp: the output and its
	 *  reference (not drawn). */
	n1: string;
	n2: string;
	/** Transistors: the base or gate, beside the main axis. */
	third?: string;
	model?: TransistorModel;
	/** E: an ideal op-amp (control = [in+, in−]). */
	opamp?: boolean;
	/** Transistors: the base/gate on the other side; op-amp: + on top. */
	mirror?: boolean;
	/** E/G: the controlling node pair; op-amp: [in+, in−]. */
	control?: [string, string];
	/** SI value (Ω, F, H, V, A, gain or S); absent for D, S, W, P. */
	value?: number;
	/** The value as written, for the drawing ("2k", "10u"). */
	valueText?: string;
	dir: Direction;
	/** Grid length in units; undefined = 1, or whatever closes the loop. */
	len?: number;
	/** Switch: its state before and after t = 0. */
	switch?: { before: boolean; after: boolean };
	/** Diode: drawn as an LED. */
	led?: boolean;
	/** Initial value (C: voltage n1−n2, L: current n1→n2) overriding the t<0 steady state. */
	ic?: number;
	/** Annotations: voltage across (+ at n1) and current (n1 → n2) labels. */
	v?: string;
	i?: string;
	label?: string;
	line: number;
}

export interface Circuit {
	elements: Element[];
	/** Node names to label in the drawing. */
	shownNodes: string[];
	/** Transient horizon end (s), when given. */
	horizon?: number;
}

export const GROUND = "0";

// ─── values ──────────────────────────────────────────────────────────────────

const PREFIX: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, k: 1e3, M: 1e6, meg: 1e6, G: 1e9 };

/** "2k", "10uF", "4.7meg", "5V", "1e-3", "100" → number; null if not one.
 *  m = milli, M or meg = mega (never SPICE's M = milli). */
export function parseSI(text: string): number | null {
	const m = /^\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(meg|[fpnuµμmkMG])?\s*(?:ohm|Ω|[VAFHWS]|Hz|s)?\s*$/.exec(text);
	if (!m) return null;
	return m[2] ? Number(`${m[1]}e${Math.round(Math.log10(PREFIX[m[2]]!))}`) : Number(m[1]);
}

const UNIT: Partial<Record<ElementKind, string>> = { R: "Ω", C: "F", L: "H", V: "V", I: "A" };

/** A value with an SI prefix and the element's unit ("2 kΩ"). */
export function formatSI(v: number, unit = ""): string {
	if (v === 0) return `0 ${unit}`.trim();
	const steps: Array<[number, string]> = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"]];
	const [k, p] = steps.find(([k]) => Math.abs(v) >= k * 0.9995) ?? steps[steps.length - 1]!;
	return `${Number((v / k).toPrecision(4))} ${p}${unit}`.trim();
}

export function elementUnit(kind: ElementKind): string {
	return UNIT[kind] ?? "";
}

// ─── parsing ─────────────────────────────────────────────────────────────────

const KINDS: ElementKind[] = ["R", "C", "L", "V", "I", "D", "S", "W", "P", "E", "G", "Q", "M"];
const NODE = /^[A-Za-z0-9_]+$/;

function parseElement(st: Statement): Element {
	const [head, opts = ""] = splitOnce(st.text, ";");
	const words = head.trim().split(/\s+/);
	const name = words[0]!;
	const kind = name[0]!.toUpperCase() as ElementKind;
	if (!KINDS.includes(kind) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
		throw new FigureError(st.line, `"${name}" is not an element — names start with R, C, L, V, I, D, S, W, P, E, G, Q or M (R1, C2, V1, Q1, W …)`);
	}
	const base = { kind, name, line: st.line, ...(st.label !== undefined ? { label: st.label } : {}) };
	const nodeOk = (ns: Array<string | undefined>) => ns.every((n) => n !== undefined && NODE.test(n));
	let el: Element;
	let rest: string[];
	if (kind === "Q" || kind === "M") {
		// SPICE order: Q collector base emitter model · M drain gate source model
		const [a, b, c, model, ...extra] = words.slice(1);
		const models = kind === "Q" ? TRANSISTOR_MODELS.slice(0, 2) : TRANSISTOR_MODELS.slice(2);
		if (!nodeOk([a, b, c]) || !model || extra.length > 0) {
			throw new FigureError(st.line, kind === "Q" ? `${name} needs collector, base, emitter and its type: "${name} c b e npn; down"` : `${name} needs drain, gate, source and its type: "${name} d g s nmos; down"`);
		}
		if (!(models as string[]).includes(model)) throw new FigureError(st.line, `${name}'s type is ${models.join(" or ")}, got "${model}"`);
		el = { ...base, n1: a!, n2: c!, third: b!, model: model as TransistorModel, dir: "down" };
		rest = [];
	} else if (kind === "E" && words[3] === "opamp") {
		// lcapy: E1 out ref opamp in+ in− — an ideal op-amp
		const [out, ref, , plus, minus, ...extra] = words.slice(1);
		if (!nodeOk([out, ref, plus, minus]) || extra.length > 0) throw new FigureError(st.line, `an op-amp is "${name} out 0 opamp in+ in-; right"`);
		el = { ...base, n1: out!, n2: ref!, control: [plus!, minus!], opamp: true, dir: "right" };
		rest = [];
	} else {
		const nodeCount = kind === "E" || kind === "G" ? 4 : 2;
		const nodes = words.slice(1, 1 + nodeCount);
		if (nodes.length < nodeCount || !nodeOk(nodes)) {
			throw new FigureError(st.line, kind === "E" || kind === "G" ? `${name} needs four nodes then its gain: "${name} out 0 a b 10" (or an op-amp: "${name} out 0 opamp in+ in-")` : `${name} needs two nodes: "${name} a b${kind === "W" || kind === "S" || kind === "D" || kind === "P" ? "" : " <value>"}; right"`);
		}
		rest = words.slice(1 + nodeCount);
		el = { ...base, n1: nodes[0]!, n2: nodes[1]!, dir: "right" };
		if (nodeCount === 4) el.control = [nodes[2]!, nodes[3]!];
	}
	if (el.n1 === el.n2) throw new FigureError(st.line, `${name} connects ${el.n1} to itself`);
	if (el.n1 === GROUND && el.n2 === GROUND && !el.opamp) throw new FigureError(st.line, `${name} has both ends on ground`);
	const needsValue = ["R", "C", "L", "V", "I", "E", "G"].includes(kind) && !el.opamp;
	if (needsValue) {
		if (rest.length !== 1) throw new FigureError(st.line, `${name} needs one value after its nodes, e.g. ${kind === "R" ? "2k" : kind === "C" ? "10u" : kind === "L" ? "5m" : kind === "V" ? "5V" : kind === "I" ? "2mA" : "10"}`);
		const v = parseSI(rest[0]!);
		if (v === null) throw new FigureError(st.line, `"${rest[0]}" is not a value — write a number with an optional SI prefix: 2k, 10u, 4.7meg, 5V (m = milli, M or meg = mega)`);
		if ((kind === "R" || kind === "C" || kind === "L") && !(v > 0)) throw new FigureError(st.line, `${name} must be positive`);
		el.value = v;
		el.valueText = rest[0]!;
	} else if (kind === "S" && rest.length === 1 && ["open", "closed", "opens", "closes"].includes(rest[0]!)) {
		const w = rest[0]!;
		el.switch = w === "open" ? { before: false, after: false } : w === "closed" ? { before: true, after: true } : w === "opens" ? { before: true, after: false } : { before: false, after: true };
	} else if (rest.length > 0) throw new FigureError(st.line, `${name} takes no value (got "${rest.join(" ")}")`);

	for (const raw of opts.split(",").map((o) => o.trim()).filter(Boolean)) {
		const m = /^(right|left|up|down)(?:\s+(\d*\.?\d+))?$/.exec(raw);
		if (m) {
			el.dir = m[1] as Direction;
			if (m[2]) el.len = Number(m[2]);
			if (el.len !== undefined && !(el.len > 0)) throw new FigureError(st.line, "a length must be positive");
			continue;
		}
		const kv = /^(v|i|ic)\s*=\s*(.+)$/.exec(raw);
		if (kv) {
			if (kv[1] === "ic") {
				if (kind !== "C" && kind !== "L") throw new FigureError(st.line, "ic (initial value) is for C and L only");
				const v = parseSI(kv[2]!);
				if (v === null) throw new FigureError(st.line, `ic must be a value, got "${kv[2]}"`);
				el.ic = v;
			} else el[kv[1] as "v" | "i"] = kv[2]!.replace(/^"|"$/g, "");
			continue;
		}
		if (kind === "S" && ["open", "closed", "opens", "closes"].includes(raw)) {
			el.switch = raw === "open" ? { before: false, after: false } : raw === "closed" ? { before: true, after: true } : raw === "opens" ? { before: true, after: false } : { before: false, after: true };
			continue;
		}
		if (kind === "D" && raw === "led") {
			el.led = true;
			continue;
		}
		if ((kind === "Q" || kind === "M" || el.opamp) && raw === "mirror") {
			el.mirror = true;
			continue;
		}
		const extra = kind === "C" || kind === "L" ? ", ic=…" : kind === "S" ? ", open/closed/opens/closes" : kind === "D" ? ", led" : kind === "Q" || kind === "M" || el.opamp ? ", mirror" : "";
		throw new FigureError(st.line, `unknown option "${raw}" — options are a direction (right, left, up, down, with an optional length: "right 2"), v=…, i=…${extra}`);
	}
	if (kind === "S" && !el.switch) throw new FigureError(st.line, `${name} needs its state: open, closed, opens (at t = 0) or closes (at t = 0)`);
	return el;
}

function splitOnce(s: string, sep: string): [string, string?] {
	const i = s.indexOf(sep);
	return i < 0 ? [s] : [s.slice(0, i), s.slice(i + 1)];
}

export function parseCircuit(source: string): Circuit {
	const elements: Element[] = [];
	const shownNodes: string[] = [];
	let horizon: number | undefined;
	for (const st of statements(source)) {
		const kw = st.text.split(/\s+/, 1)[0]!;
		if (kw === "nodes") {
			for (const n of st.text.slice(5).split(",").map((x) => x.trim()).filter(Boolean)) shownNodes.push(n);
			continue;
		}
		if (kw === "sim") {
			const m = /^sim\s+0\s*\.\.\s*(\S+)$/.exec(st.text);
			const end = m ? parseSI(m[1]!) : null;
			if (end === null || !(end > 0)) throw new FigureError(st.line, 'sim must be "sim 0..<end>", e.g. "sim 0..5m" (seconds)');
			horizon = end;
			continue;
		}
		const el = parseElement(st);
		if (el.kind !== "W" || el.name !== "W") {
			const twin = elements.find((e) => e.name === el.name);
			if (twin) throw new FigureError(st.line, `${el.name} is defined twice (also on line ${twin.line})`);
		}
		elements.push(el);
	}
	if (elements.length === 0) throw new FigureError(1, "the circuit has no elements");
	const nodes = new Set(elements.flatMap((e) => [e.n1, e.n2, ...(e.third ? [e.third] : []), ...(e.opamp ? e.control! : [])]));
	for (const e of elements) for (const c of e.control ?? []) if (!nodes.has(c)) throw new FigureError(e.line, `${e.name} is controlled by node "${c}", which no element connects to`);
	for (const n of shownNodes) if (!nodes.has(n)) throw new FigureError(1, `nodes lists "${n}", which no element connects to`);
	layoutCircuit({ elements, shownNodes, ...(horizon !== undefined ? { horizon } : {}) });
	return { elements, shownNodes, ...(horizon !== undefined ? { horizon } : {}) };
}

// ─── layout (the drawing's grid) ─────────────────────────────────────────────

export interface Point {
	x: number;
	y: number;
}
/** A placed element. Two-terminal: a = n1, b = n2. Transistor: a =
 *  collector/drain, b = emitter/source, c = base/gate. Op-amp: a = the
 *  middle of its input side, b = the output, c = in+, d = in−. */
export interface PlacedElement {
	el: Element;
	a: Point;
	b: Point;
	c?: Point;
	d?: Point;
}

const UNIT_VEC: Record<Direction, Point> = { right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };

/** The side a three-terminal part's odd terminal goes to, whatever the
 *  direction: left of a vertical part, below a horizontal one (a
 *  transistor's base/gate). Mirror takes the other side. */
function sideOf(u: Point, mirror: boolean | undefined, horizontal: Point): Point {
	const s = u.x === 0 ? { x: -1, y: 0 } : horizontal;
	return mirror ? { x: -s.x, y: -s.y } : s;
}

function transistorSide(el: Element, u: Point): Point | null {
	if (el.kind !== "Q" && el.kind !== "M") return null;
	return sideOf(u, el.mirror, { x: 0, y: 1 });
}

/** The op-amp's input spacing (grid units from the input-side middle). */
const OPAMP_IN = 0.25;

/** Place an op-amp from any one placed terminal of out, in+, in−: the
 *  inputs on its back, − on top of + (left of +, for a vertical op-amp;
 *  mirror swaps),
 *  the output `len` (default 1) further along the direction. */
function placeOpamp(el: Element, u: Point, at: (n: string) => Point | undefined, set: (n: string, p: Point) => void): PlacedElement | null {
	const len = el.len ?? 1;
	// the − input's side: on top of a horizontal op-amp, left of a vertical one
	const up = sideOf(u, false, { x: 0, y: -1 });
	const sign = el.mirror ? -1 : 1;
	const [plus, minus] = el.control!;
	const offsets: Array<[string, Point]> = [
		[el.n1, { x: u.x * len, y: u.y * len }],
		[minus, { x: up.x * OPAMP_IN * sign, y: up.y * OPAMP_IN * sign }],
		[plus, { x: -up.x * OPAMP_IN * sign, y: -up.y * OPAMP_IN * sign }],
	];
	const anchor = offsets.find(([n]) => at(n));
	if (!anchor) return null;
	const p = at(anchor[0])!;
	const back = { x: p.x - anchor[1].x, y: p.y - anchor[1].y };
	const point = (o: Point) => ({ x: back.x + o.x, y: back.y + o.y });
	for (const [n, o] of offsets) {
		const want = point(o);
		const known = at(n);
		if (known && (Math.abs(known.x - want.x) > 1e-9 || Math.abs(known.y - want.y) > 1e-9)) {
			const role = n === el.n1 ? "output" : n === minus ? "− input" : "+ input";
			throw new FigureError(el.line, `${el.name}'s ${role} ${n} should be ${describe(want.x - p.x, want.y - p.y)} of ${anchor[0]}, but other lines put it elsewhere — the inputs are ${OPAMP_IN} above and below the input side, the output ${len} along "${el.dir}"`);
		}
		if (n !== GROUND) set(n, want);
	}
	return { el, a: back, b: point(offsets[0]![1]), c: point(offsets[2]![1]), d: point(offsets[1]![1]) };
}

/** Place every node on a grid from the directions (y grows downward).
 *  Ground terminals are not nodes of the drawing — each gets its own
 *  point. Throws when two lines put a node in different places. */
export function layoutCircuit(c: Circuit): { nodes: Map<string, Point>; placed: PlacedElement[] } {
	const pos = new Map<string, Point>();
	const placed: Array<PlacedElement | undefined> = [];
	const remaining = new Set(c.elements.map((_, i) => i));
	const key = (p: Point) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
	const at = (n: string) => (n === GROUND ? undefined : pos.get(n));
	let clusterX = 0;
	while (remaining.size > 0) {
		let progressed = false;
		for (const i of [...remaining]) {
			const el = c.elements[i]!;
			const u = UNIT_VEC[el.dir];
			if (el.opamp) {
				const done = placeOpamp(el, u, at, (n, p) => pos.set(n, p));
				if (!done) continue;
				placed[i] = done;
				remaining.delete(i);
				progressed = true;
				continue;
			}
			// a transistor may be anchored by its base/gate alone
			const side = transistorSide(el, u);
			if (side && !at(el.n1) && !at(el.n2) && at(el.third!)) {
				const t = at(el.third!)!;
				const len = el.len ?? 1;
				const mid = { x: t.x - side.x * 0.5, y: t.y - side.y * 0.5 };
				if (el.n1 !== GROUND) pos.set(el.n1, { x: mid.x - (u.x * len) / 2, y: mid.y - (u.y * len) / 2 });
				else pos.set(el.n2, { x: mid.x + (u.x * len) / 2, y: mid.y + (u.y * len) / 2 });
			}
			const p1 = at(el.n1);
			const p2 = at(el.n2);
			if (!p1 && !p2) continue;
			let a: Point;
			let b: Point;
			if (p1 && p2) {
				const dx = p2.x - p1.x;
				const dy = p2.y - p1.y;
				const along = dx * u.x + dy * u.y;
				if (Math.abs(dx * u.y - dy * u.x) > 1e-9 || along <= 0) {
					throw new FigureError(
						el.line,
						`${el.name} goes ${el.dir} from ${el.n1} to ${el.n2}, but the other lines already put ${el.n2} ${describe(dx, dy)} of ${el.n1} — change its direction or the lengths so the loop closes`,
					);
				}
				if (el.len !== undefined && Math.abs(along - el.len) > 1e-9) {
					throw new FigureError(el.line, `${el.name} is ${el.len} long, but ${el.n1} and ${el.n2} are already ${Number(along.toFixed(3))} apart`);
				}
				[a, b] = [p1, p2];
			} else if (p1) {
				const len = el.len ?? 1;
				[a, b] = [p1, { x: p1.x + u.x * len, y: p1.y + u.y * len }];
				if (el.n2 !== GROUND) pos.set(el.n2, b);
			} else {
				const len = el.len ?? 1;
				[a, b] = [{ x: p2!.x - u.x * len, y: p2!.y - u.y * len }, p2!];
				if (el.n1 !== GROUND) pos.set(el.n1, a);
			}
			if (side) {
				// the base/gate: half a unit beside the middle of the main axis
				const t = { x: (a.x + b.x) / 2 + side.x * 0.5, y: (a.y + b.y) / 2 + side.y * 0.5 };
				const known = at(el.third!);
				if (known && (Math.abs(known.x - t.x) > 1e-9 || Math.abs(known.y - t.y) > 1e-9)) {
					throw new FigureError(el.line, `${el.name}'s ${el.kind === "Q" ? "base" : "gate"} ${el.third} must sit half a unit beside the middle of ${el.n1}–${el.n2}, but other lines put it ${describe(known.x - t.x, known.y - t.y)} of there — move those lines (or use "mirror" for the other side)`);
				}
				if (el.third !== GROUND) pos.set(el.third!, t);
				placed[i] = { el, a, b, c: t };
			} else placed[i] = { el, a, b };
			remaining.delete(i);
			progressed = true;
		}
		if (!progressed) {
			// a new cluster: start the first unplaced element's non-ground node
			const el = c.elements[Math.min(...remaining)]!;
			const start = el.n1 !== GROUND ? el.n1 : el.n2;
			let maxX = -Infinity;
			for (const p of pos.values()) maxX = Math.max(maxX, p.x);
			clusterX = pos.size === 0 ? 0 : maxX + 2;
			pos.set(start, { x: clusterX, y: 0 });
		}
	}
	// two different nodes on one point would be drawn as one
	const owner = new Map<string, string>();
	for (const [n, p] of pos) {
		const other = owner.get(key(p));
		if (other) {
			const line = c.elements.find((e) => [e.n1, e.n2, e.third, ...(e.control ?? [])].includes(n))?.line ?? 1;
			throw new FigureError(line, `nodes ${other} and ${n} land on the same point of the drawing — change a direction or a length`);
		}
		owner.set(key(p), n);
	}
	return { nodes: pos, placed: placed as PlacedElement[] };
}

function describe(dx: number, dy: number): string {
	const parts = [dx > 0 ? `${Number(dx.toFixed(3))} right` : dx < 0 ? `${Number((-dx).toFixed(3))} left` : "", dy > 0 ? `${Number(dy.toFixed(3))} down` : dy < 0 ? `${Number((-dy).toFixed(3))} up` : ""].filter(Boolean);
	return parts.join(" and ") || "on top";
}

// ─── solving (modified nodal analysis) ───────────────────────────────────────

/** Solvable elements' behaviour at one instant of a solve. */
interface Stamp {
	/** Conductances between node pairs. */
	g: Array<[string, string, number]>;
	/** Current sources: value driven from a to b through the source (out of b). */
	i: Array<[string, string, number]>;
	/** Voltage sources (extra unknown: their current a → b inside): V(a) − V(b) = v. */
	v: Array<{ a: string; b: string; v: number; name: string }>;
	/** VCVS: V(a) − V(b) = k (V(c) − V(d)). */
	/** ideal: an op-amp — infinite gain, so the row is V(c) − V(d) = 0. */
	e: Array<{ a: string; b: string; c: string; d: string; k: number; name: string; ideal?: boolean }>;
	/** VCCS: current k (V(c) − V(d)) from a to b through the source. */
	gm: Array<{ a: string; b: string; c: string; d: string; k: number }>;
}

export interface Solution {
	/** Node voltages (ground = 0). */
	v: Map<string, number>;
	/** Branch currents by element name, n1 → n2 through the element. */
	i: Map<string, number>;
}

const SWITCH_ON_R = 1e-6;
const GMIN = 1e-12;
const PROBE = "#probe";

/** Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
	const n = b.length;
	const M = A.map((row, i) => [...row, b[i]!]);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
		if (Math.abs(M[p]![c]!) < 1e-13) return null;
		[M[c], M[p]] = [M[p]!, M[c]!];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = M[r]![c]! / M[c]![c]!;
			if (f !== 0) for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
		}
	}
	return M.map((row, i) => row[n]! / row[i]!);
}

function solveStamp(st: Stamp, nodes: string[], ground: string): Map<string, number> {
	const idx = new Map(nodes.filter((n) => n !== ground).map((n, i) => [n, i]));
	const nv = idx.size;
	const extra = [...st.v.map((x) => x.name), ...st.e.map((x) => x.name)];
	const size = nv + extra.length;
	const A = Array.from({ length: size }, () => new Array<number>(size).fill(0));
	const rhs = new Array<number>(size).fill(0);
	const I = (n: string) => idx.get(n);
	const addA = (r: number | undefined, c: number | undefined, x: number) => {
		if (r !== undefined && c !== undefined) A[r]![c]! += x;
	};
	// gmin (as SPICE): a node behind a capacitor or an open switch would
	// otherwise float and make the system singular
	for (const r of idx.values()) A[r]![r]! += GMIN;
	for (const [a, b, g] of st.g) {
		addA(I(a), I(a), g);
		addA(I(b), I(b), g);
		addA(I(a), I(b), -g);
		addA(I(b), I(a), -g);
	}
	for (const [a, b, x] of st.i) {
		if (I(a) !== undefined) rhs[I(a)!]! -= x;
		if (I(b) !== undefined) rhs[I(b)!]! += x;
	}
	for (const { a, b, c, d, k } of st.gm) {
		for (const [node, sign] of [[a, 1], [b, -1]] as const) {
			addA(I(node), I(c), sign * k);
			addA(I(node), I(d), -sign * k);
		}
	}
	st.v.forEach(({ a, b, v }, j) => {
		const r = nv + j;
		addA(I(a), r, 1);
		addA(I(b), r, -1);
		addA(r, I(a), 1);
		addA(r, I(b), -1);
		rhs[r] = v;
	});
	st.e.forEach(({ a, b, c, d, k, ideal }, j) => {
		const r = nv + st.v.length + j;
		addA(I(a), r, 1);
		addA(I(b), r, -1);
		if (ideal) {
			// the virtual short: V(+) = V(−), the output current whatever it takes
			addA(r, I(c), 1);
			addA(r, I(d), -1);
			return;
		}
		addA(r, I(a), 1);
		addA(r, I(b), -1);
		addA(r, I(c), -k);
		addA(r, I(d), k);
	});
	const x = solveLinear(A, rhs);
	if (!x) throw new Error("the circuit cannot be solved — voltage sources (or wires) form a loop, or a voltage source is shorted");
	const out = new Map<string, number>([[ground, 0]]);
	for (const [n, i] of idx) out.set(n, x[i]!);
	extra.forEach((name, j) => out.set(`#${name}`, x[nv + j]!));
	return out;
}

/** Why the circuit cannot be solved (only drawn), or null. */
export function notSolvable(c: Circuit): string | null {
	const d = c.elements.find((e) => e.kind === "D" || e.kind === "Q" || e.kind === "M");
	if (!d) return null;
	const what = d.kind === "D" ? "a diode" : "a transistor";
	return `${d.name} is ${what} — circuits with diodes or transistors are drawn, not solved; compute by hand`;
}

interface Mode {
	/** Switch state: "before" (t < 0) or "after" (t ≥ 0). */
	phase: "before" | "after";
	/** DC: C open, L short. Transient: companion models from `prev`. */
	transient?: { h: number; prev: { vC: Map<string, number>; iL: Map<string, number> } };
	/** Equivalent resistance: independent sources zeroed. */
	zeroSources?: boolean;
}

function stampOf(c: Circuit, mode: Mode): Stamp {
	const st: Stamp = { g: [], i: [], v: [], e: [], gm: [] };
	for (const el of c.elements) {
		const { n1: a, n2: b } = el;
		switch (el.kind) {
			case "R":
				st.g.push([a, b, 1 / el.value!]);
				break;
			case "W":
				st.v.push({ a, b, v: 0, name: el.name === "W" ? `W@${el.line}` : el.name });
				break;
			case "P":
				break;
			case "S": {
				const on = mode.phase === "before" ? el.switch!.before : el.switch!.after;
				if (on) st.g.push([a, b, 1 / SWITCH_ON_R]);
				break;
			}
			case "V":
				st.v.push({ a, b, v: mode.zeroSources ? 0 : el.value!, name: el.name });
				break;
			case "I":
				// the equivalent-resistance probe is never zeroed
				if (!mode.zeroSources || el.name === PROBE) st.i.push([a, b, el.value!]);
				break;
			case "E":
				st.e.push({ a, b, c: el.control![0], d: el.control![1], k: el.value ?? Infinity, name: el.name, ...(el.opamp ? { ideal: true } : {}) });
				break;
			case "G":
				st.gm.push({ a, b, c: el.control![0], d: el.control![1], k: el.value! });
				break;
			case "C":
				if (mode.transient) {
					// backward Euler: i = C/h (v − v_prev) → G = C/h in parallel with a source
					const g = el.value! / mode.transient.h;
					st.g.push([a, b, g]);
					st.i.push([b, a, g * (mode.transient.prev.vC.get(el.name) ?? 0)]);
				}
				break;
			case "L":
				if (mode.transient) {
					// backward Euler: v = L/h (i − i_prev) → G = h/L in parallel with i_prev
					const g = mode.transient.h / el.value!;
					st.g.push([a, b, g]);
					st.i.push([a, b, mode.transient.prev.iL.get(el.name) ?? 0]);
				} else st.v.push({ a, b, v: 0, name: el.name });
				break;
			case "D":
				break;
		}
	}
	return st;
}

function branchCurrents(c: Circuit, v: Map<string, number>, mode: Mode): Map<string, number> {
	const vd = (el: Element) => (v.get(el.n1) ?? 0) - (v.get(el.n2) ?? 0);
	const i = new Map<string, number>();
	for (const el of c.elements) {
		switch (el.kind) {
			case "R":
				i.set(el.name, vd(el) / el.value!);
				break;
			case "S": {
				const on = mode.phase === "before" ? el.switch!.before : el.switch!.after;
				i.set(el.name, on ? vd(el) / SWITCH_ON_R : 0);
				break;
			}
			case "V":
			case "E":
			case "W":
				// MNA's unknown is the current a → b INSIDE the source (into a): n1 → n2 through it is the same
				i.set(el.name, v.get(`#${el.name === "W" ? `W@${el.line}` : el.name}`) ?? 0);
				break;
			case "I":
				i.set(el.name, mode.zeroSources ? 0 : el.value!);
				break;
			case "G":
				i.set(el.name, el.value! * ((v.get(el.control![0]) ?? 0) - (v.get(el.control![1]) ?? 0)));
				break;
			case "C":
				i.set(el.name, mode.transient ? (el.value! / mode.transient.h) * (vd(el) - (mode.transient.prev.vC.get(el.name) ?? 0)) : 0);
				break;
			case "L":
				i.set(el.name, mode.transient ? (mode.transient.prev.iL.get(el.name) ?? 0) + (mode.transient.h / el.value!) * vd(el) : (v.get(`#${el.name}`) ?? 0));
				break;
			default:
				i.set(el.name, 0);
		}
	}
	return i;
}

const allNodes = (c: Circuit) => [...new Set([GROUND, ...c.elements.flatMap((e) => [e.n1, e.n2, ...(e.third ? [e.third] : []), ...(e.control ?? [])])])];

function solveMode(c: Circuit, mode: Mode, ground = GROUND): Solution {
	const why = notSolvable(c);
	if (why) throw new Error(why);
	const v = solveStamp(stampOf(c, mode), allNodes(c), ground);
	return { v, i: branchCurrents(c, v, mode) };
}

/** The DC operating point with the switches in their t ≥ 0 state. */
export function solveDC(c: Circuit): Solution {
	return solveMode(c, { phase: "after" });
}

/** The resistance seen between nodes a and b (independent sources zeroed). */
export function equivalentResistance(c: Circuit, a: string, b: string): number {
	const probe: Circuit = { ...c, elements: [...c.elements, { kind: "I", name: PROBE, n1: b, n2: a, value: 1, dir: "right", line: 0 }] };
	const s = solveMode(probe, { phase: "after", zeroSources: true }, b);
	return (s.v.get(a) ?? 0) - (s.v.get(b) ?? 0);
}

export const TRANSIENT_STEPS = 4000;

export interface TransientResult {
	t: Float64Array;
	v: Map<string, Float64Array>;
	i: Map<string, Float64Array>;
}

/** From the t < 0 steady state (switches in their earlier state, or an
 *  element's ic), step to `horizon` with the switches in their t ≥ 0
 *  state (backward Euler). */
export function solveTransient(c: Circuit, horizon: number): TransientResult {
	const before = solveMode(c, { phase: "before" });
	const vC = new Map<string, number>();
	const iL = new Map<string, number>();
	for (const el of c.elements) {
		if (el.kind === "C") vC.set(el.name, el.ic ?? (before.v.get(el.n1) ?? 0) - (before.v.get(el.n2) ?? 0));
		if (el.kind === "L") iL.set(el.name, el.ic ?? before.i.get(el.name) ?? 0);
	}
	const h = horizon / TRANSIENT_STEPS;
	const nodes = allNodes(c);
	const t = new Float64Array(TRANSIENT_STEPS + 1);
	const v = new Map(nodes.map((n) => [n, new Float64Array(TRANSIENT_STEPS + 1)]));
	const i = new Map(c.elements.map((e) => [e.name, new Float64Array(TRANSIENT_STEPS + 1)]));
	// t = 0: the first step's solution with h → tiny keeps capacitor voltages and inductor currents
	const record = (k: number, s: Solution) => {
		for (const n of nodes) v.get(n)![k] = s.v.get(n) ?? 0;
		for (const e of c.elements) i.get(e.name)![k] = s.i.get(e.name) ?? 0;
	};
	record(0, solveMode(c, { phase: "after", transient: { h: h * 1e-6, prev: { vC, iL } } }));
	for (let k = 1; k <= TRANSIENT_STEPS; k++) {
		const s = solveMode(c, { phase: "after", transient: { h, prev: { vC, iL } } });
		record(k, s);
		t[k] = k * h;
		for (const el of c.elements) {
			if (el.kind === "C") vC.set(el.name, (s.v.get(el.n1) ?? 0) - (s.v.get(el.n2) ?? 0));
			if (el.kind === "L") iL.set(el.name, s.i.get(el.name) ?? 0);
		}
	}
	return { t, v, i };
}

// ─── quantities ──────────────────────────────────────────────────────────────

/** A waveform of a transient (for plots and metrics). */
export function transientSeries(c: Circuit, what: string, horizon: number): { t: Float64Array; y: Float64Array } | string {
	const m = /^(V|I)\(\s*([A-Za-z0-9_]+)\s*(?:,\s*([A-Za-z0-9_]+)\s*)?\)$/.exec(what.trim());
	if (!m) return `"${what}" is not V(node), V(a,b) or I(element)`;
	const sim = solveTransient(c, horizon);
	if (m[1] === "V") {
		const a = sim.v.get(m[2]!);
		const b = m[3] ? sim.v.get(m[3]) : sim.v.get(GROUND);
		if (!a || !b) return `the circuit has no node "${!a ? m[2] : m[3]}"`;
		return { t: sim.t, y: a.map((x, k) => x - b[k]!) };
	}
	if (m[3]) return "I(…) takes one element name";
	const i = sim.i.get(m[2]!);
	return i ? { t: sim.t, y: i } : `the circuit has no element "${m[2]}"`;
}

const NAME = "[A-Za-z0-9_]+";
const V_OR_I = new RegExp(String.raw`^(V|I)\((${NAME})(?:,(${NAME}))?(?:,t=([^)]+))?\)$`);
const METRIC_OF = new RegExp(String.raw`^([a-z]+)\(((?:V|I)\(${NAME}(?:,${NAME})?\))\)$`);

/** A circuit quantity's value, or why it has none:
 *  V(b), V(a,b), I(R1), P(R1), R(a,b) — DC with the switches in their t ≥ 0
 *  state; V(b, t=1m), I(C1, t=2m) — the transient at a time;
 *  tau(V(b)), steady(I(L1)), rise(…), settling(…), overshoot(…), peak(…). */
export function circuitQuantity(c: Circuit, quantity: string): number | string {
	const q = quantity.replace(/\s+/g, "");
	const why = notSolvable(c);
	if (why) return why;
	const nodes = allNodes(c);
	const needHorizon = 'add a "sim 0..<end>" line to the circuit (seconds, e.g. sim 0..5m) for a value in time';
	try {
		let m: RegExpExecArray | null;
		if ((m = V_OR_I.exec(q))) {
			const [, kind, x, y, at] = m;
			if (at !== undefined) {
				const time = parseSI(at);
				if (time === null) return `t=${at} is not a time`;
				if (c.horizon === undefined) return needHorizon;
				if (time > c.horizon) return `t=${at} is past the circuit's sim end`;
				const s = transientSeries(c, y ? `${kind}(${x},${y})` : `${kind}(${x})`, c.horizon);
				if (typeof s === "string") return s;
				return s.y[Math.min(TRANSIENT_STEPS, Math.max(0, Math.round((time / c.horizon) * TRANSIENT_STEPS)))]!;
			}
			const s = solveDC(c);
			if (kind === "V") {
				for (const n of [x!, y ?? GROUND]) if (!nodes.includes(n)) return `the circuit has no node "${n}"`;
				return (s.v.get(x!) ?? 0) - (s.v.get(y ?? GROUND) ?? 0);
			}
			if (y) return "I(…) takes one element name";
			if (!c.elements.some((e) => e.name === x)) return `the circuit has no element "${x}"`;
			return s.i.get(x!) ?? 0;
		}
		if ((m = new RegExp(String.raw`^P\((${NAME})\)$`).exec(q))) {
			const el = c.elements.find((e) => e.name === m![1]);
			if (!el) return `the circuit has no element "${m[1]}"`;
			const s = solveDC(c);
			return (s.i.get(el.name) ?? 0) * ((s.v.get(el.n1) ?? 0) - (s.v.get(el.n2) ?? 0));
		}
		if ((m = new RegExp(String.raw`^R\((${NAME}),(${NAME})\)$`).exec(q))) {
			for (const n of [m[1]!, m[2]!]) if (!nodes.includes(n)) return `the circuit has no node "${n}"`;
			return equivalentResistance(c, m[1]!, m[2]!);
		}
		if ((m = METRIC_OF.exec(q)) && METRICS.includes(m[1] as Metric)) {
			if (c.horizon === undefined) return needHorizon;
			const s = transientSeries(c, m[2]!, c.horizon);
			return typeof s === "string" ? s : metric(s, m[1] as Metric);
		}
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	return `"${quantity}" is not a circuit quantity — V(b), V(a,b), I(R1), P(R1), R(a,b), V(b, t=1m), I(C1, t=2m), or ${METRICS.join("/")}(V(b))`;
}

/** What a solvable circuit computes, as short sentences. */
export function circuitFacts(c: Circuit): string[] {
	if (notSolvable(c)) return [];
	const s = solveDC(c);
	const nodes = allNodes(c).filter((n) => n !== GROUND);
	return [
		`DC (t ≥ 0, steady state): ${nodes.map((n) => `V(${n}) = ${formatSI(s.v.get(n) ?? 0, "V")}`).join(", ")}`,
		`currents (n1 → n2 through each element): ${c.elements
			.filter((e) => e.kind !== "W" && e.kind !== "P")
			.map((e) => `I(${e.name}) = ${formatSI(s.i.get(e.name) ?? 0, "A")}`)
			.join(", ")}`,
	];
}
