/**
 * Logic and timing (figures phase 3, owner 2026-10-26). PURE.
 *
 * ```logic — gates and flip-flops in signal-flow form, the block-diagram
 * style: each line names its output and its inputs.
 *
 *   input a, b, clk
 *   nand n1 = a, b
 *   dff q, q_n = n1 @ clk
 *   output q
 *
 * ```timing — WaveDrom's WaveJSON ({ "signal": [{ "name", "wave",
 * "data" }] }); with "logic": "<id>" it also SIMULATES that diagram:
 * signals that carry a wave drive its inputs, signals without one are
 * computed. Values are 0, 1 or x (unknown), one per time slot.
 */

import { FigureError, IDENT, splitTopLevel, statements } from "./lines.ts";

export type GateKind = "and" | "or" | "nand" | "nor" | "xor" | "xnor" | "not" | "buf";
export type StoreKind = "dff" | "dlatch" | "sr";
export type Bit = 0 | 1 | "x";

export type LogicElement =
	| { kind: "input"; out: string; line: number; label?: string }
	| { kind: GateKind; out: string; ins: string[]; line: number; label?: string }
	| { kind: StoreKind; out: string; outN?: string; ins: string[]; init: Bit; line: number; label?: string };

export interface LogicDiagram {
	elements: LogicElement[];
	outputs: string[];
}

const GATES: GateKind[] = ["and", "or", "nand", "nor", "xor", "xnor", "not", "buf"];
const STORES: StoreKind[] = ["dff", "dlatch", "sr"];

export function isGate(k: string): k is GateKind {
	return (GATES as string[]).includes(k);
}
export function isStore(k: string): k is StoreKind {
	return (STORES as string[]).includes(k);
}

/** The signals an element reads. */
export function logicInputs(e: LogicElement): string[] {
	return e.kind === "input" ? [] : e.ins;
}

const name = (n: string, line: number, what: string) => {
	if (!IDENT.test(n)) throw new FigureError(line, `${what} "${n}" is not a valid name (letters, digits, _)`);
	return n;
};

export function parseLogic(source: string): LogicDiagram {
	const elements: LogicElement[] = [];
	const outputs: string[] = [];
	for (const st of statements(source)) {
		const kw = st.text.split(/\s+/, 1)[0]!;
		const body = st.text.slice(kw.length).trim();
		const label = st.label !== undefined ? { label: st.label } : {};
		if (kw === "input") {
			const names = splitTopLevel(body);
			if (names.length > 1 && st.label !== undefined) throw new FigureError(st.line, "a label needs its own input line");
			for (const n of names) elements.push({ kind: "input", out: name(n, st.line, "input"), line: st.line, ...label });
			continue;
		}
		if (kw === "output") {
			for (const n of splitTopLevel(body)) outputs.push(name(n, st.line, "output"));
			continue;
		}
		const eq = body.indexOf("=");
		if (!isGate(kw) && !isStore(kw)) {
			throw new FigureError(st.line, `unknown statement "${kw}" — a line starts with input, output, a gate (${GATES.join(", ")}) or a storage element (${STORES.join(", ")})`);
		}
		if (eq < 0) throw new FigureError(st.line, `${kw} needs "<output> = <inputs>"`);
		const lhs = splitTopLevel(body.slice(0, eq));
		const [rhs, opts] = body.slice(eq + 1).split(";");
		if (isGate(kw)) {
			if (lhs.length !== 1) throw new FigureError(st.line, `a gate has one output: "${kw} y = a, b"`);
			const ins = splitTopLevel(rhs!).map((n) => name(n, st.line, "input signal"));
			const unary = kw === "not" || kw === "buf";
			if (unary ? ins.length !== 1 : ins.length < 2) throw new FigureError(st.line, unary ? `${kw} takes one input: "${kw} y = a"` : `${kw} takes two or more inputs: "${kw} y = a, b"`);
			if (opts !== undefined) throw new FigureError(st.line, "gates take no options");
			elements.push({ kind: kw, out: name(lhs[0]!, st.line, "signal"), ins, line: st.line, ...label });
			continue;
		}
		// storage: dff q[, q_n] = d @ clk · dlatch q = d @ en · sr q = s, r
		if (lhs.length > 2) throw new FigureError(st.line, `${kw} has an output and an optional inverted output: "${kw} q, q_n = …"`);
		let ins: string[];
		if (kw === "sr") {
			ins = splitTopLevel(rhs!);
			if (ins.length !== 2) throw new FigureError(st.line, 'sr takes set and reset: "sr q = s, r"');
		} else {
			const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*@\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(rhs!);
			if (!m) throw new FigureError(st.line, `${kw} takes data and ${kw === "dff" ? "clock" : "enable"}: "${kw} q = d @ ${kw === "dff" ? "clk" : "en"}"`);
			ins = [m[1]!, m[2]!];
		}
		let init: Bit = 0;
		if (opts !== undefined) {
			const m = /^\s*init\s+([01])\s*$/.exec(opts);
			if (!m) throw new FigureError(st.line, `${kw} takes one option: "init 0" or "init 1"`);
			init = Number(m[1]) as 0 | 1;
		}
		elements.push({
			kind: kw,
			out: name(lhs[0]!, st.line, "signal"),
			...(lhs[1] ? { outN: name(lhs[1], st.line, "signal") } : {}),
			ins: ins.map((n) => name(n, st.line, "input signal")),
			init,
			line: st.line,
			...label,
		});
	}

	const defined = new Map<string, number>();
	for (const e of elements)
		for (const o of [e.out, ...("outN" in e && e.outN ? [e.outN] : [])]) {
			if (defined.has(o)) throw new FigureError(e.line, `signal "${o}" is defined twice (also on line ${defined.get(o)})`);
			defined.set(o, e.line);
		}
	const used = new Set(outputs);
	for (const e of elements)
		for (const i of logicInputs(e)) {
			if (!defined.has(i)) throw new FigureError(e.line, `signal "${i}" is never defined — add an input or a gate that produces it`);
			used.add(i);
		}
	if (outputs.length === 0) throw new FigureError(1, 'the diagram needs at least one "output <signal>" line');
	for (const o of outputs) if (!defined.has(o)) throw new FigureError(1, `output "${o}" is not a signal of this diagram`);
	for (const e of elements) if (!used.has(e.out) && !("outN" in e && e.outN && used.has(e.outN))) throw new FigureError(e.line, `signal "${e.out}" is never used — connect it or list it as an output`);
	return { elements, outputs };
}

// ─── evaluation ──────────────────────────────────────────────────────────────

const not = (a: Bit): Bit => (a === "x" ? "x" : a === 1 ? 0 : 1);

function gate(kind: GateKind, ins: Bit[]): Bit {
	switch (kind) {
		case "buf":
			return ins[0]!;
		case "not":
			return not(ins[0]!);
		case "and":
		case "nand": {
			const v: Bit = ins.includes(0) ? 0 : ins.includes("x") ? "x" : 1;
			return kind === "and" ? v : not(v);
		}
		case "or":
		case "nor": {
			const v: Bit = ins.includes(1) ? 1 : ins.includes("x") ? "x" : 0;
			return kind === "or" ? v : not(v);
		}
		case "xor":
		case "xnor": {
			const v: Bit = ins.includes("x") ? "x" : ((ins.filter((b) => b === 1).length % 2) as 0 | 1);
			return kind === "xor" ? v : not(v);
		}
	}
}

/** Does the diagram store state (flip-flops, latches, or gates fed back)? */
export function isSequential(d: LogicDiagram): boolean {
	if (d.elements.some((e) => isStore(e.kind))) return true;
	const byOut = new Map(d.elements.map((e) => [e.out, e]));
	const state = new Map<string, 1 | 2>();
	const loop = (s: string): boolean => {
		if (state.get(s) === 2) return false;
		if (state.get(s) === 1) return true;
		state.set(s, 1);
		const e = byOut.get(s);
		const found = e ? logicInputs(e).some(loop) : false;
		state.set(s, 2);
		return found;
	};
	return d.elements.some((e) => loop(e.out));
}

/** Settle every gate given fixed inputs and stored outputs; gates fed
 *  back iterate from `prev` (unit delay) until stable, else x. */
function settle(d: LogicDiagram, fixed: Map<string, Bit>, prev: Map<string, Bit>): Map<string, Bit> {
	const v = new Map<string, Bit>(prev);
	for (const [k, b] of fixed) v.set(k, b);
	const gates = d.elements.filter((e): e is Extract<LogicElement, { kind: GateKind }> => isGate(e.kind));
	for (let round = 0; round < 50; round++) {
		let changed = false;
		for (const g of gates) {
			const b = gate(g.kind, g.ins.map((i) => v.get(i) ?? "x"));
			if (v.get(g.out) !== b) {
				v.set(g.out, b);
				changed = true;
			}
		}
		if (!changed) return v;
	}
	for (const g of gates) v.set(g.out, "x"); // oscillates
	return v;
}

/** A combinational diagram's signal values for one input assignment. */
export function evaluateLogic(d: LogicDiagram, inputs: Record<string, 0 | 1>): Map<string, Bit> {
	if (isSequential(d)) throw new Error("the diagram stores state (a flip-flop, a latch or a feedback loop) — ask about it with a ```timing figure");
	const missing = d.elements.filter((e) => e.kind === "input" && !(e.out in inputs)).map((e) => e.out);
	if (missing.length) throw new Error(`give every input a value (missing: ${missing.join(", ")})`);
	return settle(d, new Map(Object.entries(inputs)), new Map());
}

/** Simulate slot by slot. `drive` holds the input values per slot and
 *  `rising` the rising clock edges at each slot's start. A dff samples its
 *  data from the slot BEFORE an edge (the value set up ahead of it); a D
 *  latch follows its data while enabled and an SR latch sets or resets
 *  within the slot. Storage starts at its init value. */
export function simulateLogic(d: LogicDiagram, drive: Map<string, Bit[]>, slots: number, rising: Map<string, boolean[]>): Map<string, Bit[]> {
	const history = new Map<string, Bit[]>();
	for (const e of d.elements) {
		history.set(e.out, []);
		if ("outN" in e && e.outN) history.set(e.outN, []);
	}
	const stores = d.elements.filter((e): e is Extract<LogicElement, { kind: StoreKind }> => isStore(e.kind));
	for (const s of stores) {
		if (s.kind === "dff" && !rising.has(s.ins[1]!)) throw new Error(`the clock of ${s.out} must be an input of the diagram with a wave (got "${s.ins[1]}")`);
	}
	const state = new Map<string, Bit>(stores.map((s) => [s.out, s.init]));
	let prev = new Map<string, Bit>();
	for (let k = 0; k < slots; k++) {
		const fixed = new Map<string, Bit>();
		for (const e of d.elements) if (e.kind === "input") fixed.set(e.out, drive.get(e.out)?.[k] ?? "x");
		// edge-triggered: at a rising edge, take the data from the slot before
		for (const s of stores) {
			if (s.kind === "dff" && k > 0 && rising.get(s.ins[1]!)![k]) state.set(s.out, history.get(s.ins[0]!)![k - 1] ?? "x");
		}
		const hold = () => {
			for (const s of stores) {
				fixed.set(s.out, state.get(s.out)!);
				if (s.outN) fixed.set(s.outN, not(state.get(s.out)!));
			}
		};
		hold();
		let v = settle(d, fixed, prev);
		// level-sensitive: latches settle within the slot
		for (let round = 0; round < 8; round++) {
			let changed = false;
			for (const s of stores) {
				let next = state.get(s.out)!;
				if (s.kind === "dlatch" && v.get(s.ins[1]!) === 1) next = v.get(s.ins[0]!) ?? "x";
				if (s.kind === "sr") {
					const set = v.get(s.ins[0]!);
					const reset = v.get(s.ins[1]!);
					next = set === 1 && reset === 1 ? "x" : set === 1 ? 1 : reset === 1 ? 0 : next;
				}
				if (next !== state.get(s.out)) {
					state.set(s.out, next);
					changed = true;
				}
			}
			if (!changed) break;
			hold();
			v = settle(d, fixed, v);
		}
		for (const [sig, arr] of history) arr.push(v.get(sig) ?? "x");
		prev = v;
	}
	return history;
}

// ─── timing (WaveJSON) ───────────────────────────────────────────────────────

export interface WaveSignal {
	name: string;
	wave?: string;
	data?: string[];
	/** Computed by the linked logic diagram. */
	computed?: boolean;
	/** Drawn as a blank row to fill in (still computed for checks). */
	hide?: boolean;
}
export interface Timing {
	signals: Array<WaveSignal | null>;
	logic?: string;
	tick?: number;
	slots: number;
}

const WAVE_CHARS = /^[01xzpnPNhlHL=2-9.|u d]*$/;

export function parseTiming(source: string): Timing {
	let json: unknown;
	try {
		json = JSON.parse(source);
	} catch (err) {
		throw new FigureError(1, `the timing figure is not valid JSON (WaveJSON: {"signal": [{"name": "clk", "wave": "p...."}]}) — ${err instanceof Error ? err.message : String(err)}`);
	}
	const o = json as { signal?: unknown; logic?: unknown; head?: { tick?: unknown } };
	if (!o || !Array.isArray(o.signal)) throw new FigureError(1, 'WaveJSON needs a "signal" array: {"signal": [{"name": "clk", "wave": "p...."}]}');
	const signals: Array<WaveSignal | null> = [];
	const walk = (list: unknown[]) => {
		for (const item of list) {
			if (Array.isArray(item)) walk(item.slice(typeof item[0] === "string" ? 1 : 0)); // a group: ["name", …signals]
			else if (item && typeof item === "object" && Object.keys(item).length === 0) signals.push(null);
			else if (item && typeof item === "object") {
				const s = item as { name?: unknown; wave?: unknown; data?: unknown; hide?: unknown };
				if (typeof s.name !== "string") throw new FigureError(1, 'every signal needs a "name"');
				if (s.hide !== undefined && s.wave !== undefined) throw new FigureError(1, `signal "${s.name}": hide is for computed signals (no wave)`);
				if (s.wave !== undefined && (typeof s.wave !== "string" || !WAVE_CHARS.test(s.wave))) {
					throw new FigureError(1, `signal "${s.name}": a wave uses 0 1 x z p n P N h l = 2-9 . | — got ${JSON.stringify(s.wave)}`);
				}
				const data = typeof s.data === "string" ? s.data.split(/\s+/).filter(Boolean) : Array.isArray(s.data) ? s.data.map(String) : undefined;
				signals.push({ name: s.name, ...(typeof s.wave === "string" ? { wave: s.wave } : {}), ...(data ? { data } : {}), ...(s.hide === true ? { hide: true } : {}) });
			}
		}
	};
	walk(o.signal);
	if (signals.every((s) => s === null)) throw new FigureError(1, "the timing figure has no signals");
	const slots = Math.max(0, ...signals.map((s) => s?.wave?.length ?? 0));
	return {
		signals,
		...(typeof o.logic === "string" ? { logic: o.logic } : {}),
		...(typeof o.head?.tick === "number" ? { tick: o.head.tick } : {}),
		slots,
	};
}

/** One bit per slot of a wave ('.' repeats; clocks read high in their slot). */
export function waveBits(wave: string): Bit[] {
	const bits: Bit[] = [];
	let last: Bit = "x";
	for (const c of wave) {
		if (c === ".") bits.push(last);
		else {
			last = c === "1" || c === "h" || c === "H" || c === "p" || c === "P" ? 1 : c === "0" || c === "l" || c === "L" || c === "n" || c === "N" ? 0 : "x";
			bits.push(last);
		}
	}
	return bits;
}

/** Rising edges at each slot's start: a p/P clock has one in every slot. */
export function waveRising(wave: string): boolean[] {
	const out: boolean[] = [];
	let clock: string | null = null;
	let prev: Bit = "x";
	const bits = waveBits(wave);
	[...wave].forEach((c, k) => {
		if ("pPnN".includes(c)) clock = c;
		else if (c !== ".") clock = null;
		out.push(clock === "p" || clock === "P" ? true : clock === "n" || clock === "N" ? k > 0 : prev === 0 && bits[k] === 1);
		prev = bits[k]!;
	});
	return out;
}

const waveOf = (bits: Bit[]) => bits.map((b, k) => (k > 0 && bits[k - 1] === b ? "." : String(b))).join("");

/** Fill a linked timing figure's computed signals from its logic diagram. */
export function computeTiming(t: Timing, logicSource: string | undefined): Timing {
	if (!t.logic) return t;
	if (logicSource === undefined) throw new FigureError(1, `no logic diagram with id=${t.logic} in this question — give the logic fence "id=${t.logic}"`);
	let d: LogicDiagram;
	try {
		d = parseLogic(logicSource);
	} catch (err) {
		throw new FigureError(1, `the logic diagram ${t.logic} does not parse (${err instanceof Error ? err.message : String(err)})`);
	}
	const inputs = d.elements.filter((e) => e.kind === "input").map((e) => e.out);
	const given = new Map(t.signals.filter((s): s is WaveSignal => !!s?.wave).map((s) => [s.name, s.wave!]));
	const missing = inputs.filter((i) => !given.has(i));
	if (missing.length) throw new FigureError(1, `give every input of ${t.logic} a wave (missing: ${missing.join(", ")})`);
	const drive = new Map(inputs.map((i) => [i, waveBits(given.get(i)!)]));
	const rising = new Map(inputs.map((i) => [i, waveRising(given.get(i)!)]));
	const sim = simulateLogic(d, drive, t.slots, rising);
	const signals = t.signals.map((s) => {
		if (!s || s.wave) return s;
		const bits = sim.get(s.name);
		if (!bits) throw new FigureError(1, `signal "${s.name}" has no wave and is not a signal of ${t.logic}`);
		return { ...s, wave: waveOf(bits), computed: true };
	});
	return { ...t, signals };
}

/** A logic or timing quantity: q(a=1, b=0) on a logic figure; q[3] on a timing figure. */
export function logicQuantity(lang: "logic" | "timing", source: string, quantity: string, logicOf: (id: string) => string | undefined): number | string {
	const q = quantity.replace(/\s+/g, "");
	try {
		if (lang === "logic") {
			const m = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/.exec(q);
			if (!m) return `a logic quantity is "q(a=1,b=0)" — the output for one input assignment`;
			const inputs: Record<string, 0 | 1> = {};
			for (const part of m[2]!.split(",").filter(Boolean)) {
				const kv = /^([A-Za-z_][A-Za-z0-9_]*)=([01])$/.exec(part);
				if (!kv) return `"${part}" is not an input assignment like a=1`;
				inputs[kv[1]!] = Number(kv[2]) as 0 | 1;
			}
			const v = evaluateLogic(parseLogic(source), inputs).get(m[1]!);
			if (v === undefined) return `the diagram has no signal "${m[1]}"`;
			return v === "x" ? "the value is unknown (x)" : v;
		}
		const m = /^([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]$/.exec(q);
		if (!m) return `a timing quantity is "q[3]" — a signal's value in slot 3 (slots count from 0)`;
		const t0 = parseTiming(source);
		const t = computeTiming(t0, t0.logic ? logicOf(t0.logic) : undefined);
		const s = t.signals.find((x) => x?.name === m[1]);
		if (!s?.wave) return `the timing figure has no signal "${m[1]}"`;
		const bit = waveBits(s.wave)[Number(m[2])];
		if (bit === undefined) return `slot ${m[2]} is past the end (${t.slots} slots)`;
		return bit === "x" ? "the value is unknown (x)" : bit;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/** Facts: a combinational truth table (≤ 4 inputs), or computed waves. */
export function logicFacts(lang: "logic" | "timing", source: string, logicOf: (id: string) => string | undefined): string[] {
	if (lang === "logic") {
		const d = parseLogic(source);
		if (isSequential(d)) return [];
		const inputs = d.elements.filter((e) => e.kind === "input").map((e) => e.out);
		if (inputs.length > 4) return [];
		const rows: string[] = [];
		for (let k = 0; k < 2 ** inputs.length; k++) {
			const asg = Object.fromEntries(inputs.map((n, i) => [n, ((k >> (inputs.length - 1 - i)) & 1) as 0 | 1]));
			const v = evaluateLogic(d, asg);
			rows.push(`${inputs.map((n) => `${n}=${asg[n]}`).join(" ")} → ${d.outputs.map((o) => `${o}=${v.get(o)}`).join(" ")}`);
		}
		return [`truth table: ${rows.join("; ")}`];
	}
	const t0 = parseTiming(source);
	if (!t0.logic) return [];
	const t = computeTiming(t0, logicOf(t0.logic));
	const computed = t.signals.filter((s): s is WaveSignal => !!s?.computed);
	return computed.length ? [`simulated waves (one character per slot, slots from 0): ${computed.map((s) => `${s.name}: ${waveBits(s.wave!).join("")}`).join(", ")}`] : [];
}
