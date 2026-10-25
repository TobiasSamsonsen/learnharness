/**
 * Block diagrams (figures phase 1, owner 2026-10-26). PURE, browser-safe.
 *
 * The ```blocks fence in signal-flow form: every line is a block that
 * names its output signal and the signals it takes in, so wiring and
 * signs are explicit and the drawing infers forward path and feedback.
 * The same description simulates (fixed-step RK4) — a tiny Simulink for
 * the Kyb course — so plots can show true responses and question keys
 * can be checked against them.
 *
 *   param K = 2, T = 1, K_p = 1.5
 *   input r
 *   sum e = r - y
 *   gain u = K_p * e
 *   tf y = K/(T*s + 1) * u
 *   output y
 */

import { degree, evaluate, freeVars, isFunctionName, isReservedName, parseExpr, toRational, type Expr, type Rational } from "./expr.ts";
import { FigureError, IDENT, onLine, parseInterval, parseRange, splitTopLevel, statements, type Statement } from "./lines.ts";

export type BlockKind = "input" | "sum" | "gain" | "int" | "deriv" | "tf" | "pid" | "sat" | "deadzone" | "delay";

interface BlockBase {
	kind: BlockKind;
	out: string;
	line: number;
	label?: string;
}
export type Block =
	| (BlockBase & { kind: "input" })
	| (BlockBase & { kind: "sum"; terms: Array<{ sign: 1 | -1; sig: string }> })
	| (BlockBase & { kind: "gain"; k: Expr; inSig: string })
	| (BlockBase & { kind: "int"; inSig: string; limit?: [Expr, Expr]; init?: Expr })
	| (BlockBase & { kind: "deriv"; inSig: string })
	| (BlockBase & { kind: "tf"; h: Expr; inSig: string })
	| (BlockBase & { kind: "pid"; inSig: string; form: "standard" | "parallel"; gains: Record<string, Expr> })
	| (BlockBase & { kind: "sat" | "deadzone"; inSig: string; lo: Expr; hi: Expr })
	| (BlockBase & { kind: "delay"; inSig: string; T: Expr });

export interface BlockDiagram {
	blocks: Block[];
	outputs: string[];
	/** Parameter definitions in order (a value may use earlier ones). */
	params: Array<{ name: string; value: Expr; line: number }>;
	/** Simulation horizon end (start is 0). */
	horizon: number;
	/** Free names with no `param` value — the diagram draws, but cannot simulate. */
	symbols: string[];
}

export const DEFAULT_HORIZON = 20;

/** The signals a block reads. */
export function blockInputs(b: Block): string[] {
	if (b.kind === "input") return [];
	if (b.kind === "sum") return b.terms.map((t) => t.sig);
	return [b.inSig];
}

/** Every expression a block carries (for symbol collection). */
function blockExprs(b: Block): Expr[] {
	switch (b.kind) {
		case "gain":
			return [b.k];
		case "int":
			return [...(b.limit ?? []), ...(b.init ? [b.init] : [])];
		case "tf":
			return [b.h];
		case "pid":
			return Object.values(b.gains);
		case "sat":
		case "deadzone":
			return [b.lo, b.hi];
		case "delay":
			return [b.T];
		default:
			return [];
	}
}

// ─── parsing ─────────────────────────────────────────────────────────────────

const KEYWORDS = new Set(["param", "input", "output", "sim", "sum", "gain", "int", "deriv", "tf", "pid", "sat", "deadzone", "delay"]);
const PID_STANDARD = ["K_p", "T_i", "T_d"];
const PID_PARALLEL = ["K_p", "K_i", "K_d"];

/** Signals may be named `e` (the control error — signal names never meet
 *  the constant, they stay out of parameter expressions); parameters may
 *  not shadow a function or constant, and nothing may be named `s`. */
function checkName(name: string, line: number, what: string): void {
	if (!IDENT.test(name)) throw new FigureError(line, `${what} "${name}" is not a valid name (letters, digits, _)`);
	const reserved = what === "parameter" ? isReservedName(name) : isFunctionName(name);
	if (reserved || name === "s") throw new FigureError(line, `"${name}" is reserved — pick another ${what} name`);
}

/** `out = rhs[; options]` → its parts. */
function assignment(st: Statement, keyword: string): { out: string; rhs: string; options?: string } {
	const body = st.text.slice(keyword.length).trim();
	const eq = body.indexOf("=");
	if (eq < 0) throw new FigureError(st.line, `${keyword} needs "<output signal> = …"`);
	const out = body.slice(0, eq).trim();
	checkName(out, st.line, "signal");
	const rest = body.slice(eq + 1);
	const semi = rest.indexOf(";");
	return semi < 0 ? { out, rhs: rest.trim() } : { out, rhs: rest.slice(0, semi).trim(), options: rest.slice(semi + 1).trim() };
}

/** `coef * sig`, `sig * coef`, `sig / coef` or `-sig` → [coefficient, signal]. */
function linearIn(ast: Expr, signals: ReadonlySet<string>): [Expr, string] | null {
	const isSig = (e: Expr) => e.k === "var" && signals.has(e.name);
	const free = (e: Expr) => [...freeVars(e)].every((n) => !signals.has(n));
	if (ast.k === "var" && signals.has(ast.name)) return [{ k: "num", v: 1 }, ast.name];
	if (ast.k === "neg" && isSig(ast.a)) return [{ k: "num", v: -1 }, (ast.a as { name: string }).name];
	if (ast.k === "bin" && ast.op === "*") {
		if (isSig(ast.b) && free(ast.a)) return [ast.a, (ast.b as { name: string }).name];
		if (isSig(ast.a) && free(ast.b)) return [ast.b, (ast.a as { name: string }).name];
	}
	if (ast.k === "bin" && ast.op === "/" && isSig(ast.a) && free(ast.b)) {
		return [{ k: "bin", op: "/", a: { k: "num", v: 1 }, b: ast.b }, (ast.a as { name: string }).name];
	}
	return null;
}

function singleSignal(rhs: string, st: Statement, keyword: string): string {
	if (!IDENT.test(rhs)) throw new FigureError(st.line, `${keyword} takes one signal: "${keyword} <out> = <in>"`);
	return rhs;
}

/** Parse a ```blocks source. Throws FigureError (line + message). */
export function parseBlocks(source: string): BlockDiagram {
	const sts = statements(source);
	const blocks: Block[] = [];
	const outputs: string[] = [];
	const params: BlockDiagram["params"] = [];
	let horizon = DEFAULT_HORIZON;
	const keywordOf = (st: Statement) => st.text.split(/\s+/, 1)[0]!;

	// pass 1: every signal name (inputs + block outputs), so a right side
	// can tell a signal from a parameter
	const signals = new Set<string>();
	for (const st of sts) {
		const kw = keywordOf(st);
		if (!KEYWORDS.has(kw)) {
			throw new FigureError(st.line, `unknown statement "${kw}" — a line starts with one of: ${[...KEYWORDS].join(", ")}`);
		}
		if (kw === "input") for (const n of splitTopLevel(st.text.slice(5))) signals.add(n);
		else if (!["param", "output", "sim"].includes(kw)) {
			const eq = st.text.indexOf("=");
			if (eq > 0) signals.add(st.text.slice(kw.length, eq).trim());
		}
	}

	for (const st of sts) {
		const kw = keywordOf(st);
		const label = st.label !== undefined ? { label: st.label } : {};
		switch (kw) {
			case "param":
				for (const part of splitTopLevel(st.text.slice(5))) {
					const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(part);
					if (!m) throw new FigureError(st.line, `param takes "name = value" pairs, got "${part}"`);
					checkName(m[1]!, st.line, "parameter");
					if (signals.has(m[1]!)) throw new FigureError(st.line, `"${m[1]}" is both a signal and a parameter`);
					if (params.some((p) => p.name === m[1])) throw new FigureError(st.line, `parameter "${m[1]}" is defined twice`);
					params.push({ name: m[1]!, value: onLine(st.line, () => parseExpr(m[2]!), m[1]), line: st.line });
				}
				break;
			case "sim": {
				const [start, end] = parseRange(st.text.slice(3), st.line, "sim");
				if (start !== 0) throw new FigureError(st.line, "sim starts at 0 (sim 0..20)");
				horizon = end;
				break;
			}
			case "input": {
				const names = splitTopLevel(st.text.slice(5));
				if (names.length > 1 && st.label !== undefined) throw new FigureError(st.line, "a label needs its own input line");
				for (const n of names) {
					checkName(n, st.line, "input");
					blocks.push({ kind: "input", out: n, line: st.line, ...label });
				}
				break;
			}
			case "output":
				for (const n of splitTopLevel(st.text.slice(6))) {
					if (!signals.has(n)) throw new FigureError(st.line, `output "${n}" is not a signal of this diagram`);
					if (!outputs.includes(n)) outputs.push(n);
				}
				break;
			case "sum": {
				const { out, rhs } = assignment(st, kw);
				const terms: Array<{ sign: 1 | -1; sig: string }> = [];
				const re = /\s*([+-]?)\s*([A-Za-z_][A-Za-z0-9_]*)/y;
				let m: RegExpExecArray | null;
				let consumed = 0;
				while ((m = re.exec(rhs))) {
					if (terms.length > 0 && !m[1]) break;
					terms.push({ sign: m[1] === "-" ? -1 : 1, sig: m[2]! });
					consumed = re.lastIndex;
				}
				if (terms.length < 2 || rhs.slice(consumed).trim()) {
					throw new FigureError(st.line, `sum takes two or more signed signals: "sum e = r - y"`);
				}
				blocks.push({ kind: "sum", out, terms, line: st.line, ...label });
				break;
			}
			case "gain":
			case "tf": {
				const { out, rhs } = assignment(st, kw);
				const ast = onLine(st.line, () => parseExpr(rhs));
				const lin = linearIn(ast, signals);
				if (!lin && ![...freeVars(ast)].some((n) => signals.has(n))) {
					throw new FigureError(st.line, `${kw} reads no signal of this diagram (its names: ${[...freeVars(ast)].join(", ") || "none"}; signals: ${[...signals].join(", ")}) — a signal must be defined by an input or a block`);
				}
				if (!lin) {
					throw new FigureError(
						st.line,
						kw === "gain" ? `gain must be "<factor> * <signal>", e.g. "gain u = K_p * e"` : `tf must be "<transfer function> * <signal>", e.g. "tf y = K/(T*s + 1) * u"`,
					);
				}
				if (kw === "gain") {
					if (freeVars(lin[0]).has("s")) throw new FigureError(st.line, "a gain cannot contain s — use tf for a transfer function");
					blocks.push({ kind: "gain", out, k: lin[0], inSig: lin[1], line: st.line, ...label });
				} else blocks.push({ kind: "tf", out, h: lin[0], inSig: lin[1], line: st.line, ...label });
				break;
			}
			case "int": {
				const { out, rhs, options } = assignment(st, kw);
				const block: Block = { kind: "int", out, inSig: singleSignal(rhs, st, kw), line: st.line, ...label };
				for (const opt of options ? splitTopLevel(options) : []) {
					if (opt.startsWith("limit")) {
						const [lo, hi] = parseInterval(opt.slice(5), st.line, "limit");
						block.limit = [onLine(st.line, () => parseExpr(lo)), onLine(st.line, () => parseExpr(hi))];
					} else if (opt.startsWith("init")) block.init = onLine(st.line, () => parseExpr(opt.slice(4)), "init");
					else throw new FigureError(st.line, `int options are "limit [lo, hi]" and "init <value>", got "${opt}"`);
				}
				blocks.push(block);
				break;
			}
			case "deriv": {
				const { out, rhs } = assignment(st, kw);
				blocks.push({ kind: "deriv", out, inSig: singleSignal(rhs, st, kw), line: st.line, ...label });
				break;
			}
			case "pid": {
				const { out, rhs, options } = assignment(st, kw);
				const gains: Record<string, Expr> = {};
				for (const opt of options ? splitTopLevel(options) : []) {
					const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(opt);
					if (!m) throw new FigureError(st.line, `pid takes "name = value" gains after ";", got "${opt}"`);
					gains[m[1]!] = onLine(st.line, () => parseExpr(m[2]!), m[1]);
				}
				const names = Object.keys(gains);
				const form = names.every((n) => PID_STANDARD.includes(n)) ? "standard" : names.every((n) => PID_PARALLEL.includes(n)) ? "parallel" : null;
				if (!form || !("K_p" in gains || "K_i" in gains || "K_d" in gains)) {
					throw new FigureError(st.line, "pid gains are either K_p, T_i, T_d (standard form) or K_p, K_i, K_d (parallel form): \"pid u = e; K_p = 2, T_i = 1\"");
				}
				if (form === "standard" && !("K_p" in gains)) throw new FigureError(st.line, "the standard pid form needs K_p");
				blocks.push({ kind: "pid", out, inSig: singleSignal(rhs, st, kw), form, gains, line: st.line, ...label });
				break;
			}
			case "sat":
			case "deadzone": {
				const { out, rhs } = assignment(st, kw);
				const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/.exec(rhs);
				if (!m) throw new FigureError(st.line, `${kw} must be "${kw} <out> = <in> in [lo, hi]"`);
				const [lo, hi] = parseInterval(m[2]!, st.line, kw);
				blocks.push({ kind: kw, out, inSig: m[1]!, lo: onLine(st.line, () => parseExpr(lo)), hi: onLine(st.line, () => parseExpr(hi)), line: st.line, ...label });
				break;
			}
			case "delay": {
				const { out, rhs, options } = assignment(st, kw);
				if (!options) throw new FigureError(st.line, 'delay needs its time after ";": "delay z = y; 0.5"');
				blocks.push({ kind: "delay", out, inSig: singleSignal(rhs, st, kw), T: onLine(st.line, () => parseExpr(options), "delay time"), line: st.line, ...label });
				break;
			}
		}
	}

	// every signal defined once, every input defined, nothing dangling
	const defined = new Map<string, number>();
	for (const b of blocks) {
		if (defined.has(b.out)) throw new FigureError(b.line, `signal "${b.out}" is defined twice (also on line ${defined.get(b.out)})`);
		defined.set(b.out, b.line);
	}
	const used = new Set<string>(outputs);
	for (const b of blocks)
		for (const sig of blockInputs(b)) {
			if (!defined.has(sig)) throw new FigureError(b.line, `signal "${sig}" is never defined — add a block or an input that produces it`);
			used.add(sig);
		}
	if (outputs.length === 0) throw new FigureError(sts.at(-1)?.line ?? 1, 'the diagram needs at least one "output <signal>" line');
	for (const b of blocks) {
		if (!used.has(b.out)) throw new FigureError(b.line, `signal "${b.out}" is never used — connect it to a block or list it as an output`);
	}

	const paramNames = new Set(params.map((p) => p.name));
	const symbols = new Set<string>();
	for (const p of params) for (const n of freeVars(p.value)) if (!paramNames.has(n)) symbols.add(n);
	for (const b of blocks)
		for (const e of blockExprs(b))
			for (const n of freeVars(e)) {
				if (signals.has(n)) throw new FigureError(b.line, `signal "${n}" cannot appear inside a block's parameters`);
				if (n !== "s" && !paramNames.has(n)) symbols.add(n);
			}
	for (const b of blocks) {
		if (b.kind !== "tf" && blockExprs(b).some((e) => freeVars(e).has("s"))) throw new FigureError(b.line, "only tf blocks may contain s");
	}

	const diagram: BlockDiagram = { blocks, outputs, params, horizon, symbols: [...symbols] };
	checkAlgebraicLoops(diagram);
	if (diagram.symbols.length === 0) {
		const vars = paramValues(diagram);
		for (const b of blocks) {
			if (b.kind !== "tf") continue;
			const r = onLine(b.line, () => toRational(b.h, vars));
			if (degree(r.num) > degree(r.den)) {
				throw new FigureError(b.line, "this transfer function is improper (numerator degree above the denominator's) — use deriv or pid for a derivative");
			}
		}
	}
	return diagram;
}

// ─── structure ───────────────────────────────────────────────────────────────

/** Does the block's output depend on its input at the same instant? */
function feedsThrough(b: Block, vars: Readonly<Record<string, number>> | null): boolean {
	if (b.kind === "int" || b.kind === "delay" || b.kind === "input") return false;
	if (b.kind === "tf") {
		if (!vars) return false; // symbolic: drawn as a dynamic block
		const r = toRational(b.h, vars);
		return degree(r.num) === degree(r.den);
	}
	return true;
}

function checkAlgebraicLoops(d: BlockDiagram): void {
	const vars = d.symbols.length === 0 ? paramValues(d) : null;
	const byOut = new Map(d.blocks.map((b) => [b.out, b]));
	const state = new Map<string, 1 | 2>();
	const path: string[] = [];
	const visit = (sig: string): void => {
		const b = byOut.get(sig)!;
		if (state.get(sig) === 2 || !feedsThrough(b, vars)) return;
		if (state.get(sig) === 1) {
			const cycle = path.slice(path.indexOf(sig));
			throw new FigureError(b.line, `algebraic loop through ${[...cycle, sig].join(" → ")} — a feedback loop needs an int, a strictly proper tf or a delay`);
		}
		state.set(sig, 1);
		path.push(sig);
		for (const inp of blockInputs(b)) visit(inp);
		path.pop();
		state.set(sig, 2);
	};
	for (const b of d.blocks) visit(b.out);
}

/** The parameter values (each may use earlier ones). */
export function paramValues(d: BlockDiagram): Record<string, number> {
	const vars: Record<string, number> = {};
	for (const p of d.params) vars[p.name] = onLine(p.line, () => evaluate(p.value, vars), p.name);
	return vars;
}

/** Why the diagram cannot simulate, or null. */
export function notSimulatable(d: BlockDiagram): string | null {
	return d.symbols.length > 0 ? `give every parameter a value to simulate (missing: ${d.symbols.join(", ")} — add "param ${d.symbols[0]} = …")` : null;
}

// ─── simulation ──────────────────────────────────────────────────────────────

export type ExcitationKind = "step" | "ramp" | "impulse" | "sine";
export interface Excitation {
	input: string;
	kind: ExcitationKind;
	/** step amplitude or sine frequency (Hz). */
	a?: number;
}

/** "step r", "step(2) r", "ramp r", "impulse r", "sine(0.5) r". */
export function parseExcitation(text: string): Excitation | string {
	const m = /^\s*(step|ramp|impulse|sine)\s*(?:\(\s*(-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*\))?\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(text);
	if (!m) return 'an excitation is "step r", "step(2) r", "ramp r", "impulse r" or "sine(0.5) r"';
	if (m[1] === "sine" && m[2] === undefined) return "sine needs its frequency in Hz: sine(0.5) r";
	return { kind: m[1] as ExcitationKind, input: m[3]!, ...(m[2] !== undefined ? { a: Number(m[2]) } : {}) };
}

export const SIM_STEPS = 4000;

export interface SimResult {
	t: Float64Array;
	signals: Record<string, Float64Array>;
}

interface Dyn {
	block: Block;
	/** Offset into the state vector and its size. */
	off: number;
	nx: number;
	ft: boolean;
	tf?: { A: number[][]; B: number[]; C: number[]; D: number };
	limit?: [number, number];
	gains?: { p: number; i: number; d: number };
	k?: number;
	lo?: number;
	hi?: number;
	T?: number;
	/** deriv/pid memory: the last accepted input and its time. */
	mem?: { t: number; u: number; d: number; init: boolean };
	/** delay history (accepted steps). */
	hist?: { t: number[]; u: number[] };
}

function canonical(r: Rational): { A: number[][]; B: number[]; C: number[]; D: number } {
	const n = degree(r.den);
	const a = r.den; // monic
	const b = Array.from({ length: n + 1 }, (_, i) => r.num[i] ?? 0);
	const D = b[n]!;
	const C = Array.from({ length: n }, (_, i) => b[i]! - D * a[i]!);
	const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i < n - 1 ? (j === i + 1 ? 1 : 0) : -a[j]!)));
	const B = Array.from({ length: n }, (_, i) => (i === n - 1 ? 1 : 0));
	return { A, B, C, D };
}

/** Simulate from t = 0 to `horizon` (default: the diagram's) with the
 *  given excitations; unexcited inputs are 0. Throws when the diagram is
 *  symbolic or an excitation names no input. */
export function simulate(d: BlockDiagram, excitations: readonly Excitation[], horizon = d.horizon): SimResult {
	const why = notSimulatable(d);
	if (why) throw new Error(why);
	const vars = paramValues(d);
	const num = (e: Expr, line: number) => onLine(line, () => evaluate(e, vars));
	const h = horizon / SIM_STEPS;
	const inputs = new Map<string, (t: number) => number>();
	for (const ex of excitations) {
		if (!d.blocks.some((b) => b.kind === "input" && b.out === ex.input)) throw new Error(`"${ex.input}" is not an input of the diagram`);
		const a = ex.a ?? 1;
		inputs.set(
			ex.input,
			ex.kind === "step" ? (t) => (t >= 0 ? a : 0) : ex.kind === "ramp" ? (t) => Math.max(0, t) : ex.kind === "impulse" ? (t) => (t >= 0 && t < h ? 1 / h : 0) : (t) => Math.sin(2 * Math.PI * a * t),
		);
	}

	// runtime blocks
	let nx = 0;
	const dyn: Dyn[] = d.blocks.map((b) => {
		const r: Dyn = { block: b, off: nx, nx: 0, ft: true };
		switch (b.kind) {
			case "input":
				r.ft = false;
				break;
			case "gain":
				r.k = num(b.k, b.line);
				break;
			case "int":
				r.nx = 1;
				r.ft = false;
				if (b.limit) r.limit = [num(b.limit[0], b.line), num(b.limit[1], b.line)];
				break;
			case "tf": {
				r.tf = canonical(toRational(b.h, vars));
				r.nx = r.tf.C.length;
				r.ft = r.tf.D !== 0 || r.nx === 0;
				break;
			}
			case "deriv":
				r.mem = { t: 0, u: 0, d: 0, init: false };
				break;
			case "pid": {
				const g = (n: string) => (b.gains[n] ? num(b.gains[n]!, b.line) : undefined);
				const p = g("K_p") ?? 0;
				r.gains = b.form === "standard" ? { p, i: g("T_i") ? p / g("T_i")! : 0, d: p * (g("T_d") ?? 0) } : { p, i: g("K_i") ?? 0, d: g("K_d") ?? 0 };
				r.nx = r.gains.i !== 0 ? 1 : 0;
				r.mem = { t: 0, u: 0, d: 0, init: false };
				break;
			}
			case "sat":
			case "deadzone":
				r.lo = num(b.lo, b.line);
				r.hi = num(b.hi, b.line);
				break;
			case "delay":
				r.T = num(b.T, b.line);
				r.ft = false;
				r.hist = { t: [], u: [] };
				break;
		}
		nx += r.nx;
		return r;
	});
	const byOut = new Map(dyn.map((r) => [r.block.out, r]));

	// feedthrough blocks in dependency order (no algebraic loops by parse)
	const order: Dyn[] = [];
	const seen = new Set<string>();
	const place = (r: Dyn) => {
		if (seen.has(r.block.out)) return;
		seen.add(r.block.out);
		if (r.ft) for (const inp of blockInputs(r.block)) place(byOut.get(inp)!);
		if (r.ft) order.push(r);
	};
	for (const r of dyn) place(r);

	const derivOf = (r: Dyn, t: number, u: number) => {
		const m = r.mem!;
		if (!m.init) return 0;
		return t > m.t ? (u - m.u) / (t - m.t) : m.d;
	};
	const delayed = (r: Dyn, t: number) => {
		const { t: ts, u: us } = r.hist!;
		const at = t - r.T!;
		if (at < 0 || ts.length === 0) return 0;
		if (at >= ts[ts.length - 1]!) return us[us.length - 1]!;
		let lo = 0;
		let hi = ts.length - 1;
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1;
			if (ts[mid]! <= at) lo = mid;
			else hi = mid;
		}
		const f = (at - ts[lo]!) / (ts[hi]! - ts[lo]! || 1);
		return us[lo]! + f * (us[hi]! - us[lo]!);
	};

	/** All signal values at (t, X). */
	const signalsAt = (t: number, X: Float64Array): Record<string, number> => {
		const v: Record<string, number> = {};
		for (const r of dyn) {
			const b = r.block;
			if (b.kind === "input") v[b.out] = inputs.get(b.out)?.(t) ?? 0;
			else if (b.kind === "int") v[b.out] = X[r.off]!;
			else if (b.kind === "delay") v[b.out] = delayed(r, t);
			else if (b.kind === "tf" && !r.ft) v[b.out] = r.tf!.C.reduce((s, c, i) => s + c * X[r.off + i]!, 0);
		}
		for (const r of order) {
			const b = r.block;
			const u = b.kind === "sum" ? 0 : v[(b as { inSig: string }).inSig]!;
			switch (b.kind) {
				case "sum":
					v[b.out] = b.terms.reduce((s, term) => s + term.sign * v[term.sig]!, 0);
					break;
				case "gain":
					v[b.out] = r.k! * u;
					break;
				case "tf":
					v[b.out] = r.tf!.C.reduce((s, c, i) => s + c * X[r.off + i]!, 0) + r.tf!.D * u;
					break;
				case "deriv":
					v[b.out] = derivOf(r, t, u);
					break;
				case "pid":
					v[b.out] = r.gains!.p * u + (r.nx ? r.gains!.i * X[r.off]! : 0) + r.gains!.d * derivOf(r, t, u);
					break;
				case "sat":
					v[b.out] = Math.min(r.hi!, Math.max(r.lo!, u));
					break;
				case "deadzone":
					v[b.out] = u > r.hi! ? u - r.hi! : u < r.lo! ? u - r.lo! : 0;
					break;
			}
		}
		return v;
	};

	const deriv = (t: number, X: Float64Array): Float64Array => {
		const v = signalsAt(t, X);
		const dX = new Float64Array(nx);
		for (const r of dyn) {
			const b = r.block;
			if (r.nx === 0) continue;
			const u = v[(b as { inSig: string }).inSig]!;
			if (b.kind === "int") {
				const x = X[r.off]!;
				dX[r.off] = r.limit && ((x >= r.limit[1] && u > 0) || (x <= r.limit[0] && u < 0)) ? 0 : u;
			} else if (b.kind === "pid") dX[r.off] = u;
			else if (b.kind === "tf") {
				const { A, B } = r.tf!;
				for (let i = 0; i < r.nx; i++) dX[r.off + i] = A[i]!.reduce((s, a, j) => s + a * X[r.off + j]!, 0) + B[i]! * u;
			}
		}
		return dX;
	};

	let X = new Float64Array(nx);
	for (const r of dyn) {
		const b = r.block;
		if (b.kind === "int") X[r.off] = b.init ? num(b.init, b.line) : 0;
	}
	const clamp = () => {
		for (const r of dyn) if (r.limit) X[r.off] = Math.min(r.limit[1], Math.max(r.limit[0], X[r.off]!));
	};
	clamp();

	const t = new Float64Array(SIM_STEPS + 1);
	const signals: Record<string, Float64Array> = {};
	for (const r of dyn) signals[r.block.out] = new Float64Array(SIM_STEPS + 1);
	const accept = (k: number, tk: number) => {
		const v = signalsAt(tk, X);
		t[k] = tk;
		for (const r of dyn) {
			signals[r.block.out]![k] = v[r.block.out]!;
			const b = r.block;
			if (r.mem) {
				const u = v[(b as { inSig: string }).inSig]!;
				r.mem.d = r.mem.init && tk > r.mem.t ? (u - r.mem.u) / (tk - r.mem.t) : r.mem.d;
				r.mem.t = tk;
				r.mem.u = u;
				r.mem.init = true;
			}
			if (r.hist) {
				r.hist.t.push(tk);
				r.hist.u.push(v[(b as { inSig: string }).inSig]!);
			}
		}
	};
	accept(0, 0);
	const add = (a: Float64Array, b: Float64Array, k: number) => a.map((x, i) => x + k * b[i]!);
	for (let k = 1; k <= SIM_STEPS; k++) {
		const t0 = (k - 1) * h;
		const k1 = deriv(t0, X);
		const k2 = deriv(t0 + h / 2, add(X, k1, h / 2));
		const k3 = deriv(t0 + h / 2, add(X, k2, h / 2));
		const k4 = deriv(t0 + h, add(X, k3, h));
		X = X.map((x, i) => x + (h / 6) * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!));
		clamp();
		accept(k, k * h);
	}
	return { t, signals };
}
