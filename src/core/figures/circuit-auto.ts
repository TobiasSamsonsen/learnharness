/**
 * Automatic layout of a ```circuit (owner, 2026-11-25): the tutor writes the netlist only; this places every part and routes every wire.
 *
 * Why: a model cannot reliably plan the 2-D geometry a hand-directed netlist needs (op-amp input offsets, loops that close, parts
 * that must not sit on each other), whatever the model effort. Topology it writes reliably, so the geometry is a pure function of
 * the netlist: deterministic (a seeded search), so the validator, the renderer and every device draw the same picture.
 *
 * Output: the same circuit with a direction and a length on every element plus the wires between them (extra "W" elements on
 * nodes named by their grid point), i.e. an ordinary directed netlist that layoutDirected (circuit.ts) places and checks exactly
 * as before. Units: quarter grid units (Q = 4 per unit); op-amp inputs sit one Q above and below the input side.
 */
import type { Circuit, Direction, Element } from "./circuit.ts";

const GND = "0";
/** Search effort: ~2 s of search per hundred parts on a laptop; tuned so a typical figure (6–10 parts) lays out in a few hundred ms. */
const BUDGET_SCALE = 3;
const Q = 4;
type Pt = { x: number; y: number };
const DIRS: Pt[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
const DIRNAME: Direction[] = ["right", "down", "left", "up"];

type Kind = "two" | "opamp" | "trans";
interface Comp {
	el: Element;
	kind: Kind;
	/** The net at each pin (two: n1, n2 · op-amp: out, −, + · transistor: C, E, B). "0" = a ground connection of its own. */
	nets: string[];
}
interface St {
	x: number;
	y: number;
	/** two-terminal: 0 right, 1 down, 2 left, 3 up */
	o: number;
	/** two-terminal length in grid units */
	l: number;
	m: boolean;
}

const key = (x: number, y: number) => (x + 2048) * 4096 + (y + 2048);
const keyOf = (p: Pt) => key(p.x, p.y);
const ekey = (a: Pt, b: Pt) => (keyOf(a) < keyOf(b) ? keyOf(a) * 16777216 + keyOf(b) : keyOf(b) * 16777216 + keyOf(a));

function pinsOf(c: Comp, s: St): Pt[] {
	if (c.kind === "two") {
		const d = DIRS[s.o]!;
		return [{ x: s.x, y: s.y }, { x: s.x + d.x * s.l * Q, y: s.y + d.y * s.l * Q }];
	}
	if (c.kind === "opamp") {
		const top = { x: s.x, y: s.y - 1 };
		const bottom = { x: s.x, y: s.y + 1 };
		return [{ x: s.x + Q, y: s.y }, s.m ? bottom : top, s.m ? top : bottom];
	}
	return [{ x: s.x, y: s.y }, { x: s.x, y: s.y + Q }, { x: s.x + (s.m ? 2 : -2), y: s.y + 2 }];
}

function bodyPoints(c: Comp, s: St): Pt[] {
	const out: Pt[] = [];
	if (c.kind === "two") {
		const [a, b] = pinsOf(c, s);
		const d = DIRS[s.o]!;
		const n = s.l * Q;
		for (let i = 0; i <= n; i++) out.push({ x: a!.x + d.x * i, y: a!.y + d.y * i });
		void b;
		return out;
	}
	if (c.kind === "opamp") {
		// the triangle and its name above it; the output pin (column 4) is outside, so a wire may leave it up or down
		for (let i = 0; i < Q; i++) for (let j = -3; j <= 2; j++) out.push({ x: s.x + i, y: s.y + j });
		out.push({ x: s.x + Q, y: s.y });
		return out;
	}
	for (let i = s.m ? -1 : -2; i <= (s.m ? 2 : 1); i++) for (let j = 0; j <= Q; j++) out.push({ x: s.x + i, y: s.y + j });
	return out;
}

/** The part of a body a wire may not touch: a two-terminal part's pins are its only attachment points. */
function isPin(c: Comp, s: St, p: Pt): number {
	return pinsOf(c, s).findIndex((q) => q.x === p.x && q.y === p.y);
}

// ─── deterministic random numbers ────────────────────────────────────────────

function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

// ─── routing of one state ────────────────────────────────────────────────────

interface Route {
	net: string;
	pts: Pt[][]; // polylines
}
interface Eval {
	cost: number;
	hard: number;
	routes: Route[];
}

// The grid every state is evaluated on: cells hold stamps (a generation number) instead of being cleared between evaluations.
const OFF = 32;
const SZ = 160;
const CELLS = SZ * SZ;
const cellOf = (x: number, y: number) => (x + OFF) * SZ + (y + OFF);
const inGrid = (x: number, y: number) => x >= -OFF && y >= -OFF && x < SZ - OFF && y < SZ - OFF;
const bodyGen = new Int32Array(CELLS);
const bodyCnt = new Int8Array(CELLS);
const bodyOwner = new Int16Array(CELLS);
const groundGen = new Int32Array(CELLS);
const labelGen = new Int32Array(CELLS);
const pinGen = new Int32Array(CELLS);
const pinNet = new Int16Array(CELLS);
const pinCnt = new Int8Array(CELLS);
const wireGen = new Int32Array(CELLS);
const wireNetA = new Int16Array(CELLS);
const wireNetB = new Int16Array(CELLS);
const wireKey = new Uint8Array(CELLS);
const edgeGenH = new Int32Array(CELLS);
const edgeNetH = new Int16Array(CELLS);
const edgeGenV = new Int32Array(CELLS);
const edgeNetV = new Int16Array(CELLS);
let gen = 0;

function candidates(a: Pt, b: Pt, wide: boolean): Pt[][] {
	if (a.x === b.x && a.y === b.y) return [[a]];
	const out: Pt[][] = [];
	if (a.x === b.x || a.y === b.y) out.push([a, b]);
	if (a.x !== b.x && a.y !== b.y) {
		out.push([a, { x: b.x, y: a.y }, b], [a, { x: a.x, y: b.y }, b]);
		const mx = Math.round((a.x + b.x) / 2 / Q) * Q;
		const my = Math.round((a.y + b.y) / 2 / Q) * Q;
		if (mx !== a.x && mx !== b.x) out.push([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]);
		if (my !== a.y && my !== b.y) out.push([a, { x: a.x, y: my }, { x: b.x, y: my }, b]);
	}
	if (wide) {
		const lox = Math.min(a.x, b.x);
		const loy = Math.min(a.y, b.y);
		const hix = Math.max(a.x, b.x);
		const hiy = Math.max(a.y, b.y);
		for (const off of [Q, 2 * Q, 3 * Q]) {
			for (const y of [loy - off, hiy + off]) out.push([a, { x: a.x, y }, { x: b.x, y }, b]);
			for (const x of [lox - off, hix + off]) out.push([a, { x, y: a.y }, { x, y: b.y }, b]);
		}
		// leave and arrive with a short stub, so a part's pins can be reached from the side that is free
		for (const off of [Q, 2 * Q, 3 * Q]) {
			for (const yv of [loy - off, hiy + off]) {
				for (const da of [Q, -Q]) for (const db of [Q, -Q]) out.push([a, { x: a.x + da, y: a.y }, { x: a.x + da, y: yv }, { x: b.x + db, y: yv }, { x: b.x + db, y: b.y }, b]);
			}
			for (const xv of [lox - off, hix + off]) {
				for (const da of [Q, -Q]) for (const db of [Q, -Q]) out.push([a, { x: a.x, y: a.y + da }, { x: xv, y: a.y + da }, { x: xv, y: b.y + db }, { x: b.x, y: b.y + db }, b]);
			}
		}
	}
	return out;
}

function simplify(path: Pt[]): Pt[] {
	const out: Pt[] = [];
	for (const p of path) {
		const last = out[out.length - 1];
		if (last && last.x === p.x && last.y === p.y) continue;
		out.push(p);
		while (out.length >= 3) {
			const a = out[out.length - 3]!;
			const b = out[out.length - 2]!;
			const c = out[out.length - 1]!;
			if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(out.length - 2, 1);
			else break;
		}
	}
	return out;
}

/** Part A of a state's score: bodies, pins and the ground clearance. Fills the stamped grids. */
function evaluate(comps: Comp[], st: St[], netId: Map<string, number>, wide: boolean, keepRoutes: boolean): Eval {
	gen++;
	const n = comps.length;
	let hard = 0;
	let soft = 0;
	const allPins: Pt[][] = new Array(n);
	const pinNets: number[][] = new Array(n);
	for (let i = 0; i < n; i++) {
		const c = comps[i]!;
		const s = st[i]!;
		const pins = pinsOf(c, s);
		allPins[i] = pins;
		pinNets[i] = c.nets.map((nn, j) => (nn === GND ? 1000 + i * 4 + j : netId.get(nn)!));
		const pts = bodyPoints(c, s);
		for (let k = 0; k < pts.length; k++) {
			const p = pts[k]!;
			if (!inGrid(p.x, p.y)) { hard += 5; continue; }
			const cell = cellOf(p.x, p.y);
			if (bodyGen[cell] !== gen) { bodyGen[cell] = gen; bodyCnt[cell] = 1; bodyOwner[cell] = i; } else bodyCnt[cell] = (bodyCnt[cell] ?? 0) + 1;
		}
		for (let j = 0; j < pins.length; j++) {
			const p = pins[j]!;
			if (!inGrid(p.x, p.y)) continue;
			const cell = cellOf(p.x, p.y);
			if (pinGen[cell] !== gen) { pinGen[cell] = gen; pinCnt[cell] = 1; pinNet[cell] = pinNets[i]![j]!; }
			else { pinCnt[cell] = (pinCnt[cell] ?? 0) + 1; if (pinNet[cell] !== pinNets[i]![j]!) pinNet[cell] = -1; }
		}
	}
	// bodies on bodies are fine only where parts of one net meet at their pins
	for (let i = 0; i < n; i++) {
		for (const p of bodyPoints(comps[i]!, st[i]!)) {
			if (!inGrid(p.x, p.y)) continue;
			const cell = cellOf(p.x, p.y);
			if ((bodyCnt[cell] ?? 0) > 1 && !(pinGen[cell] === gen && (pinNet[cell] ?? -1) >= 0 && (pinNet[cell] ?? 0) < 1000 && pinCnt[cell] === bodyCnt[cell])) {
				hard += 1;
				bodyCnt[cell] = 1; // count a crowded cell once
			}
		}
	}
	// a ground connection hangs a symbol below it: nothing may sit there
	for (let i = 0; i < n; i++) {
		const pins = allPins[i]!;
		for (let j = 0; j < pins.length; j++) {
			if (comps[i]!.nets[j] !== GND) continue;
			const p = pins[j]!;
			for (let d = 1; d <= 3; d++) {
				if (!inGrid(p.x, p.y + d)) continue;
				const cell = cellOf(p.x, p.y + d);
				if (bodyGen[cell] === gen || pinGen[cell] === gen) hard += 1;
				groundGen[cell] = gen;
			}
			const other = pins[j === 0 ? 1 : 0]!;
			if (comps[i]!.kind === "two" && other.y > p.y) soft += 4;
		}
	}
	// nets
	const nets = new Map<number, Pt[]>();
	for (let i = 0; i < n; i++) {
		const pins = allPins[i]!;
		for (let j = 0; j < pins.length; j++) {
			const id = pinNets[i]![j]!;
			if (id >= 1000) continue;
			const list = nets.get(id);
			const p = pins[j]!;
			if (!list) nets.set(id, [p]);
			else if (!list.some((q) => q.x === p.x && q.y === p.y)) list.push(p);
		}
	}
	const routes: Route[] = [];
	const order = [...nets.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
	for (const [id, pts] of order) {
		const inTree = [pts[0]!];
		const rest = pts.slice(1);
		const polylines: Pt[][] = [];
		while (rest.length > 0) {
			let bd = Infinity;
			let bi = 0;
			let bt = inTree[0]!;
			for (let i = 0; i < rest.length; i++) {
				const p = rest[i]!;
				for (const t of inTree) {
					const d = Math.abs(p.x - t.x) + Math.abs(p.y - t.y);
					if (d < bd) { bd = d; bi = i; bt = t; }
				}
			}
			const p = rest.splice(bi, 1)[0]!;
			let chosen: Pt[] = [];
			let chosenCost = Infinity;
			for (const cand of candidates(bt, p, wide)) {
				let cost = Math.max(0, cand.length - 2) * 2;
				for (let s = 0; s + 1 < cand.length && cost < chosenCost; s++) {
					const a = cand[s]!;
					const b = cand[s + 1]!;
					const dx = Math.sign(b.x - a.x);
					const dy = Math.sign(b.y - a.y);
					const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
					for (let k = 0; k <= len; k++) {
						const x = a.x + dx * k;
						const y = a.y + dy * k;
						if (!inGrid(x, y)) { cost += 60; continue; }
						cost += 0.25;
						const cell = cellOf(x, y);
						if (bodyGen[cell] === gen && !(pinGen[cell] === gen && pinNet[cell] === id)) cost += 40;
						else if (pinGen[cell] === gen && pinNet[cell] !== id) cost += 40;
						else if (groundGen[cell] === gen) cost += 12;
						if (wireGen[cell] === gen && wireNetA[cell] !== id && (wireNetB[cell] === -1 || wireNetB[cell] !== id)) cost += wireKey[cell] ? 40 : 3;
					}
				}
				if (cost < chosenCost) { chosenCost = cost; chosen = cand; }
			}
			const path = simplify(chosen);
			polylines.push(path);
			for (let s = 0; s + 1 < path.length; s++) {
				const a = path[s]!;
				const b = path[s + 1]!;
				const dx = Math.sign(b.x - a.x);
				const dy = Math.sign(b.y - a.y);
				const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
				for (let k = 0; k <= len; k++) {
					const x = a.x + dx * k;
					const y = a.y + dy * k;
					if (!inGrid(x, y)) continue;
					const cell = cellOf(x, y);
					const isKey = k === 0 || k === len ? 1 : 0;
					// the cell: its net(s), and whether any of them has a corner/pin/end here
					if (wireGen[cell] !== gen) { wireGen[cell] = gen; wireNetA[cell] = id; wireNetB[cell] = -1; wireKey[cell] = isKey; }
					else if (wireNetA[cell] !== id && wireNetB[cell] !== id) { wireNetB[cell] = id; wireKey[cell] = (wireKey[cell] ?? 0) | isKey; if (wireKey[cell]) hard += 1; else soft += 8; }
					else wireKey[cell] = (wireKey[cell] ?? 0) | isKey;
					// a wire on a body (other than at its own pin) or on a foreign pin
					if (bodyGen[cell] === gen && !(pinGen[cell] === gen && pinNet[cell] === id)) hard += 1;
					else if (pinGen[cell] === gen && pinNet[cell] !== id && !(bodyGen[cell] === gen)) hard += 1;
					if (k < len) {
						const ex = dx !== 0 ? Math.min(x, x + dx) : x;
						const ey = dy !== 0 ? Math.min(y, y + dy) : y;
						const ec = cellOf(ex, ey);
						if (dx !== 0) { if (edgeGenH[ec] === gen && edgeNetH[ec] !== id) hard += 1; edgeGenH[ec] = gen; edgeNetH[ec] = id; }
						else { if (edgeGenV[ec] === gen && edgeNetV[ec] !== id) hard += 1; edgeGenV[ec] = gen; edgeNetV[ec] = id; }
					}
				}
			}
			inTree.push(p);
			soft += Math.max(0, path.length - 2) * 3;
			for (let s = 0; s + 1 < path.length; s++) soft += (Math.abs(path[s + 1]!.x - path[s]!.x) + Math.abs(path[s + 1]!.y - path[s]!.y)) / Q * 1.4;
		}
		if (keepRoutes) routes.push({ net: String(id), pts: polylines });
	}
	// a part's name and value are drawn beside it (above a horizontal one, right of a vertical one; a transistor's on the side away
	// from its base): keep wires, parts and ground symbols off that spot
	const labelHit = (x0: number, x1: number, y0: number, y1: number, owner: number) => {
		let hit = 0;
		for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
			if (!inGrid(x, y)) continue;
			const cell = cellOf(x, y);
			if (wireGen[cell] === gen) hit += 3;
			if (groundGen[cell] === gen) hit += 3;
			if (bodyGen[cell] === gen && !(bodyCnt[cell] === 1 && bodyOwner[cell] === owner)) hit += 3;
			// two names drawn over each other are unreadable
			if (labelGen[cell] === gen) hit += 6;
			labelGen[cell] = gen;
		}
		return hit;
	};
	for (let i = 0; i < n; i++) {
		const c = comps[i]!;
		const pins = allPins[i]!;
		if (c.kind === "trans") {
			const s = st[i]!;
			soft += s.m ? labelHit(s.x - 5, s.x - 2, s.y + 1, s.y + 3, i) : labelHit(s.x + 2, s.x + 5, s.y + 1, s.y + 3, i);
			continue;
		}
		if (c.kind !== "two" || c.el.kind === "W" || c.el.kind === "P") continue;
		const chars = c.el.name.length + (c.el.valueText?.length ?? 0) + 1;
		const w = Math.max(4, Math.ceil(chars * 0.4));
		const mx = (pins[0]!.x + pins[1]!.x) / 2;
		const my = (pins[0]!.y + pins[1]!.y) / 2;
		if (pins[0]!.y === pins[1]!.y) soft += labelHit(Math.floor(mx - w / 2), Math.ceil(mx + w / 2), Math.floor(my) - 2, Math.floor(my) - 1, i);
		else soft += labelHit(Math.floor(mx) + 2, Math.floor(mx) + 1 + w, Math.floor(my) - 1, Math.floor(my) + 1, i);
	}
	// compactness, the preferred orientation of the sources, no needlessly long parts
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const pins of allPins) for (const p of pins) {
		if (p.x < minX) minX = p.x;
		if (p.x > maxX) maxX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.y > maxY) maxY = p.y;
	}
	soft += ((maxX - minX) + (maxY - minY)) / Q * 0.8 + ((maxX - minX) * (maxY - minY)) / (Q * Q) * 0.35;
	for (let i = 0; i < n; i++) {
		const c = comps[i]!;
		const s = st[i]!;
		if (c.kind === "two" && (c.el.kind === "V" || c.el.kind === "I") && s.o % 2 === 0) soft += 3;
		// a source's + end up (the first node on top), and a part tied to ground stands upright above it
		if (c.kind === "two" && c.el.kind === "V" && s.o === 3) soft += 2;
		if (c.kind === "two" && c.el.kind !== "W" && (c.nets[0] === GND || c.nets[1] === GND) && s.o % 2 === 0) soft += 3;
		if (c.kind === "two" && c.el.kind === "W" && s.o !== 1) soft += 3;
		if (c.kind === "opamp" && s.m) soft += 3; // − on top is the usual drawing
		if (c.kind === "two" && s.l > 2) soft += (s.l - 2) * 0.5;
	}
	return { cost: hard * 60 + soft, hard, routes };
}

// ─── the search ──────────────────────────────────────────────────────────────

function clampSt(s: St): void {
	s.x = Math.max(0, Math.min(100, s.x));
	s.y = Math.max(0, Math.min(100, s.y));
}

function search(comps: Comp[], netId: Map<string, number>, seed: number, iterations: number): { st: St[]; ev: Eval } {
	const rand = rng(seed);
	const n = comps.length;
	let cur: St[] = comps.map((c, i) => ({
		x: Math.round((i % 4) * 2.2 * Q) + Math.floor(rand() * 3) * Q,
		y: Math.round(Math.floor(i / 4) * 2.2 * Q) + Math.floor(rand() * 3) * Q,
		o: c.kind === "two" ? Math.floor(rand() * 4) : 0,
		l: 1 + Math.floor(rand() * 2),
		m: false,
	}));
	let curEv = evaluate(comps, cur, netId, false, false);
	let best = cur;
	let bestEv = curEv;
	const T0 = 8;
	const T1 = 0.1;
	for (let it = 0; it < iterations; it++) {
		const T = T0 * Math.pow(T1 / T0, it / iterations);
		const i = Math.floor(rand() * n);
		const next = cur.slice();
		const s = { ...cur[i]! };
		next[i] = s;
		const r = rand();
		if (r < 0.5) {
			const step = rand() < 0.75 ? Q : 1;
			const k = 1 + Math.floor(rand() * 2);
			if (rand() < 0.5) s.x += (rand() < 0.5 ? -1 : 1) * step * k;
			else s.y += (rand() < 0.5 ? -1 : 1) * step * k;
		} else if (r < 0.62) {
			// line a pin up with another part's pin (straight wires)
			const pa = pinsOf(comps[i]!, s);
			const j = Math.floor(rand() * n);
			if (j !== i) {
				const pb = pinsOf(comps[j]!, cur[j]!);
				const a = pa[Math.floor(rand() * pa.length)]!;
				const b = pb[Math.floor(rand() * pb.length)]!;
				if (rand() < 0.5) s.x += b.x - a.x;
				else s.y += b.y - a.y;
			}
		} else if (r < 0.74 && comps[i]!.kind === "two") s.o = Math.floor(rand() * 4);
		else if (r < 0.82 && comps[i]!.kind === "two") s.l = 1 + Math.floor(rand() * 3);
		else if (r < 0.88 && comps[i]!.kind !== "two") s.m = !s.m;
		else {
			const t = cur[Math.floor(rand() * n)]!;
			s.x = t.x + (Math.floor(rand() * 5) - 2) * Q;
			s.y = t.y + (Math.floor(rand() * 5) - 2) * Q;
		}
		clampSt(s);
		const ev = evaluate(comps, next, netId, false, false);
		if (ev.cost <= curEv.cost || rand() < Math.exp((curEv.cost - ev.cost) / T)) {
			cur = next;
			curEv = ev;
			if (ev.cost < bestEv.cost) { best = next; bestEv = ev; }
		}
	}
	// the winner, routed with every detour on offer
	return { st: best, ev: evaluate(comps, best, netId, true, true) };
}

// ─── netlist ↔ components ────────────────────────────────────────────────────

export interface AutoLayout {
	circuit: Circuit;
	/** The net at each pin of the first `parts.length` elements of `circuit` (the parts, in order; ground connections are "0"). */
	parts: Array<{ kind: Kind; nets: string[] }>;
	/** Every original node name → the point name of one of its pins (for labels). */
	where: Map<string, string>;
	hard: number;
}

const cache = new Map<string, AutoLayout>();

/** One layout of the circuit; `attempt` > 0 searches again from another seed with more room (used when an attempt did not check out). */
export function autoDirect(c: Circuit, attempt = 0): AutoLayout {
	const sig = JSON.stringify(c.elements.map((e) => [e.kind, e.name, e.n1, e.n2, e.third, e.control, e.mirror, e.valueText, e.led, e.switch, e.v, e.i, e.label])) + "#" + attempt;
	const hit = cache.get(sig);
	if (hit) return hit;
	const result = build(c, sig, attempt);
	if (cache.size > 200) cache.clear();
	cache.set(sig, result);
	return result;
}

function build(c: Circuit, sig: string, attempt: number): AutoLayout {
	// wires only say two nodes are one: merge them (ground wins)
	const parent = new Map<string, string>();
	const find = (a: string): string => {
		let r = a;
		while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
		return r;
	};
	const union = (a: string, b: string) => {
		const ra = find(a);
		const rb = find(b);
		if (ra === rb) return;
		if (ra === GND) parent.set(rb, ra);
		else if (rb === GND) parent.set(ra, rb);
		else if (ra < rb) parent.set(rb, ra);
		else parent.set(ra, rb);
	};
	for (const e of c.elements) if (e.kind === "W") union(e.n1, e.n2);
	const net = (n: string) => find(n);
	const comps: Comp[] = [];
	for (const e of c.elements) {
		if (e.kind === "W") continue;
		if (e.opamp) comps.push({ el: e, kind: "opamp", nets: [net(e.n1), net(e.control![1]), net(e.control![0])] });
		else if (e.kind === "Q" || e.kind === "M") comps.push({ el: e, kind: "trans", nets: [net(e.n1), net(e.n2), net(e.third!)] });
		else comps.push({ el: e, kind: "two", nets: [net(e.n1), net(e.n2)] });
	}
	// a grounded pin of an op-amp or transistor gets a short wire to its own ground symbol (a symbol right at the pin would sit
	// inside the part's body)
	let stubs = 0;
	for (const comp of [...comps]) {
		if (comp.kind === "two") continue;
		comp.nets.forEach((nn, j) => {
			if (nn !== GND) return;
			const stub = `#g${stubs++}`;
			comp.nets[j] = stub;
			comps.push({ el: { kind: "W", name: "W", n1: stub, n2: GND, dir: "down", line: 0 }, kind: "two", nets: [stub, GND] });
		});
	}
	const netId = new Map<string, number>();
	const names: string[] = [];
	for (const comp of comps) for (const nn of comp.nets) if (nn !== GND && !netId.has(nn)) { netId.set(nn, names.length); names.push(nn); }
	const base = hash(sig);
	let best: { st: St[]; ev: Eval } | null = null;
	const budget = Math.min(4000, 700 + comps.length * 300) * (1 + attempt * 0.75) * BUDGET_SCALE * ((globalThis as { __autoBudget?: number }).__autoBudget ?? 1);
	for (let k = 0; k < 3; k++) {
		const r = search(comps, netId, base + k * 7919 + attempt * 104729, budget);
		if (!best || r.ev.cost < best.ev.cost) best = r;
		if (best.ev.hard === 0) break;
	}
	for (const r of best!.ev.routes) r.net = names[Number(r.net)]!;
	return emit(c, comps, best!.st, best!.ev, net);
}

function emit(c: Circuit, comps: Comp[], st: St[], ev: Eval, net: (n: string) => string): AutoLayout {
	// shift so every coordinate is non-negative, then name a node by its point
	let minX = Infinity;
	let minY = Infinity;
	for (let i = 0; i < comps.length; i++) for (const p of pinsOf(comps[i]!, st[i]!)) {
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
	}
	for (const r of ev.routes) for (const pl of r.pts) for (const p of pl) {
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
	}
	if (!Number.isFinite(minX)) {
		minX = 0;
		minY = 0;
	}
	const nm = (p: Pt) => `_${p.x - minX}_${p.y - minY}`;
	const out: Element[] = [];
	const where = new Map<string, string>();
	let line = 0;
	for (let i = 0; i < comps.length; i++) {
		const comp = comps[i]!;
		const s = st[i]!;
		const pins = pinsOf(comp, s);
		const nameOf = (j: number) => (comp.nets[j] === GND ? GND : nm(pins[j]!));
		const note = (j: number) => {
			if (comp.nets[j] !== GND && !where.has(comp.nets[j]!)) where.set(comp.nets[j]!, nm(pins[j]!));
		};
		pins.forEach((_, j) => note(j));
		const el = comp.el;
		line++;
		if (comp.kind === "two") out.push({ ...el, n1: nameOf(0), n2: nameOf(1), dir: DIRNAME[s.o]!, len: s.l, line });
		else if (comp.kind === "opamp") out.push({ ...el, n1: nameOf(0), n2: GND, control: [nameOf(2), nameOf(1)], mirror: s.m || undefined, dir: "right", len: 1, line });
		else out.push({ ...el, n1: nameOf(0), n2: nameOf(1), third: nameOf(2), mirror: s.m || undefined, dir: "down", len: 1, line });
	}
	// wires: split every polyline at the points where another wire of the net meets it, then one W per straight stretch
	for (const r of ev.routes) {
		const points = new Map<number, Pt>();
		const degree = new Map<number, number>();
		const segs: Array<[Pt, Pt]> = [];
		for (const pl of r.pts) for (let i = 0; i + 1 < pl.length; i++) segs.push([pl[i]!, pl[i + 1]!]);
		// unit edges, deduplicated
		const edges = new Map<number, [Pt, Pt]>();
		for (const [a, b] of segs) {
			const dx = Math.sign(b.x - a.x);
			const dy = Math.sign(b.y - a.y);
			const n = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
			for (let k = 0; k < n; k++) {
				const u = { x: a.x + dx * k, y: a.y + dy * k };
				const v = { x: u.x + dx, y: u.y + dy };
				edges.set(ekey(u, v), [u, v]);
			}
		}
		const adj = new Map<number, Pt[]>();
		for (const [u, v] of edges.values()) {
			for (const [p, q] of [[u, v], [v, u]] as const) {
				const k = keyOf(p);
				points.set(k, p);
				const list = adj.get(k) ?? [];
				list.push(q);
				adj.set(k, list);
				degree.set(k, list.length);
			}
		}
		const pinPoints = new Set<number>();
		for (let i = 0; i < comps.length; i++) comps[i]!.nets.forEach((n, j) => { if (n === r.net) pinPoints.add(keyOf(pinsOf(comps[i]!, st[i]!)[j]!)); });
		const isKey = (k: number) => {
			const nb = adj.get(k)!;
			if (pinPoints.has(k) || nb.length !== 2) return true;
			const p = points.get(k)!;
			return !(nb[0]!.x === p.x && nb[1]!.x === p.x) && !(nb[0]!.y === p.y && nb[1]!.y === p.y);
		};
		const seen = new Set<number>();
		for (const [k0, p0] of points) {
			if (!isKey(k0)) continue;
			for (const first of adj.get(k0)!) {
				let prev = p0;
				let cur = first;
				const ekFirst = ekey(p0, first);
				if (seen.has(ekFirst)) continue;
				let steps = 1;
				seen.add(ekFirst);
				while (!isKey(keyOf(cur))) {
					const next = adj.get(keyOf(cur))!.find((q) => !(q.x === prev.x && q.y === prev.y))!;
					seen.add(ekey(cur, next));
					prev = cur;
					cur = next;
					steps++;
				}
				const dx = Math.sign(cur.x - p0.x);
				const dy = Math.sign(cur.y - p0.y);
				const dir = DIRS.findIndex((d) => d.x === dx && d.y === dy);
				line++;
				out.push({ kind: "W", name: "W", n1: nm(p0), n2: nm(cur), dir: DIRNAME[dir]!, len: steps / Q, line });
			}
		}
	}
	// every name the netlist uses (wire-merged ones included) points at where its net is drawn
	for (const e of c.elements) {
		for (const n of [e.n1, e.n2, ...(e.third ? [e.third] : []), ...(e.control ?? [])]) {
			const point = where.get(net(n));
			if (point && !where.has(n)) where.set(n, point);
		}
	}
	return { circuit: { elements: out, shownNodes: c.shownNodes, ...(c.horizon !== undefined ? { horizon: c.horizon } : {}) }, parts: comps.map((cm) => ({ kind: cm.kind, nets: cm.el.kind === "W" && cm.nets[1] === GND ? [cm.nets[0]!, cm.nets[0]!] : cm.nets })), where, hard: ev.hard };
}

// ─── the drawing means the circuit ───────────────────────────────────────────

interface PlacedLike {
	el: Element;
	a: Pt;
	b: Pt;
	c?: Pt;
	d?: Pt;
}

/**
 * Read the wiring back off the drawn geometry and compare it with the netlist: every net's pins must land in one electrical
 * piece, no two nets in the same one, and no wire may end on the body of a part. Wires connect at their ends and where an end
 * lands on another wire; two wires crossing in the middle do not connect. Returns the first problem, or null.
 */
export function verifyDrawing(auto: AutoLayout, placed: PlacedLike[]): string | null {
	const k4 = (p: Pt) => `${Math.round(p.x * 4)},${Math.round(p.y * 4)}`;
	const parent = new Map<string, string>();
	const find = (a: string): string => {
		let r = a;
		while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
		parent.set(a, r);
		return r;
	};
	const touch = (a: string) => { if (!parent.has(a)) parent.set(a, a); };
	const union = (a: string, b: string) => { touch(a); touch(b); parent.set(find(a), find(b)); };
	const wires = placed.filter((p) => p.el.kind === "W");
	const bodies = placed.filter((p) => p.el.kind !== "W" && !p.el.opamp && p.el.kind !== "Q" && p.el.kind !== "M" && p.el.kind !== "P");
	const parts = placed.slice(0, auto.parts.length);
	const pinPoints: Pt[][] = parts.map((p, i) => {
		const kind = auto.parts[i]!.kind;
		if (kind === "two") return [p.a, p.b];
		if (kind === "opamp") return [p.b, p.d!, p.c!];
		return [p.a, p.b, p.c!];
	});
	const conductors: Pt[] = [];
	for (const w of wires) { union(k4(w.a), k4(w.b)); conductors.push(w.a, w.b); }
	for (const pins of pinPoints) for (const p of pins) { touch(k4(p)); conductors.push(p); }
	const onSegment = (p: Pt, a: Pt, b: Pt) => {
		const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
		if (Math.abs(cross) > 1e-9) return false;
		const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
		const len = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
		return dot > 1e-9 && dot < len - 1e-9;
	};
	for (const p of conductors) for (const w of wires) if (onSegment(p, w.a, w.b)) union(k4(p), k4(w.a));
	for (const p of conductors) for (const body of bodies) if (onSegment(p, body.a, body.b)) return `a wire or pin lands on ${body.el.name}'s body`;
	const seen = new Map<string, string>();
	const pieceOf = new Map<string, string>();
	let ground = 0;
	for (let i = 0; i < parts.length; i++) {
		for (let j = 0; j < pinPoints[i]!.length; j++) {
			const net = auto.parts[i]!.nets[j]!;
			const piece = find(k4(pinPoints[i]![j]!));
			const id = net === GND ? `#${ground++}` : net;
			const prevPiece = pieceOf.get(id);
			if (prevPiece !== undefined && prevPiece !== piece) return `node ${net} is drawn as two separate pieces`;
			pieceOf.set(id, piece);
			const owner = seen.get(piece);
			if (owner !== undefined && owner !== id) return `nodes ${owner.startsWith("#") ? "0" : owner} and ${net === GND ? "0" : net} are drawn connected`;
			seen.set(piece, id);
		}
	}
	return null;
}
