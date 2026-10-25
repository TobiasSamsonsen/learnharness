/**
 * Plots (figures phase 1, owner 2026-10-26). PURE, browser-safe.
 *
 * The ```plot fence: axes, then one line per curve — an expression, an
 * ODE (RK4), a block diagram's simulated response, or samples — plus
 * markers. Computed here, drawn by components/figures/plot-svg.ts.
 *
 *   axes t 0..10, y "y(t)"
 *   curve y = 1 - exp(-t/2)  "T = 2"
 *   ode x' = -x + 2*u, x(0) = 0, u = step(t)  "K = 2"
 *   response loop1 y to step r  "closed loop"
 *   samples sin(2*pi*3*t), fs = 8
 *   mark t = 2  "T"
 */

import { evaluate, freeVars, isReservedName, parseExpr, type Expr } from "./expr.ts";
import { FigureError, onLine, parseRange, splitTopLevel, statements } from "./lines.ts";
import { notSimulatable, parseBlocks, parseExcitation, simulate, type BlockDiagram } from "./blocks.ts";
import { parseCircuit, transientSeries } from "./circuit.ts";

export type PlotItem =
	| { kind: "curve"; name: string; expr: Expr; line: number; label?: string }
	| { kind: "ode"; states: Array<{ name: string; rhs: Expr; init: Expr }>; aux: Array<{ name: string; expr: Expr }>; line: number; label?: string }
	| { kind: "response"; figure: string; signal: string; excitation: string; line: number; label?: string }
	| { kind: "transient"; figure: string; what: string; line: number; label?: string }
	| { kind: "samples"; expr: Expr; fs: number; line: number; label?: string }
	| { kind: "mark"; axis: "x" | "y" | "point"; at: [number, number] | number; line: number; label?: string };

export interface PlotSpec {
	x: { name: string; range: [number, number]; label?: string };
	y: { name: string; range?: [number, number]; label?: string };
	params: Array<{ name: string; value: Expr; line: number }>;
	items: PlotItem[];
}

const PLOT_KEYWORDS = ["axes", "xlabel", "param", "curve", "ode", "response", "transient", "samples", "mark"];

export function parsePlot(source: string): PlotSpec {
	const sts = statements(source);
	let spec: PlotSpec | null = null;
	let xlabel: string | undefined;
	const params: PlotSpec["params"] = [];
	const items: PlotItem[] = [];
	for (const st of sts) {
		const kw = st.text.split(/\s+/, 1)[0]!;
		const body = st.text.slice(kw.length).trim();
		const label = st.label !== undefined ? { label: st.label } : {};
		if (!PLOT_KEYWORDS.includes(kw)) throw new FigureError(st.line, `unknown statement "${kw}" — a line starts with one of: ${PLOT_KEYWORDS.join(", ")}`);
		if (kw !== "axes" && kw !== "param" && kw !== "xlabel" && !spec) throw new FigureError(st.line, 'the first line must be "axes", e.g. "axes t 0..10, y"');
		switch (kw) {
			case "axes": {
				if (spec) throw new FigureError(st.line, "axes is given twice");
				const [xPart, yPart = "y"] = splitTopLevel(body);
				const xm = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(xPart!);
				if (!xm) throw new FigureError(st.line, 'axes must be "axes <x> <from>..<to>, <y> [<from>..<to>]", e.g. "axes t 0..10, y"');
				const ym = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.+))?$/.exec(yPart);
				if (!ym) throw new FigureError(st.line, 'the y axis is "<name>" or "<name> <from>..<to>"');
				spec = {
					x: { name: xm[1]!, range: parseRange(xm[2]!, st.line, "the x range") },
					y: { name: ym[1]!, ...(ym[2] ? { range: parseRange(ym[2], st.line, "the y range") } : {}), ...label },
					params,
					items,
				};
				break;
			}
			case "xlabel":
				if (st.label === undefined || body) throw new FigureError(st.line, 'xlabel takes only a quoted label: xlabel "t [s]"');
				xlabel = st.label;
				break;
			case "param":
				for (const part of splitTopLevel(body)) {
					const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(part);
					if (!m) throw new FigureError(st.line, `param takes "name = value" pairs, got "${part}"`);
					if (isReservedName(m[1]!)) throw new FigureError(st.line, `"${m[1]}" is reserved`);
					params.push({ name: m[1]!, value: onLine(st.line, () => parseExpr(m[2]!), m[1]), line: st.line });
				}
				break;
			case "curve": {
				const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(body);
				if (!m) throw new FigureError(st.line, 'curve must be "curve <name> = <expression>", e.g. "curve y = 1 - exp(-t/2)"');
				items.push({ kind: "curve", name: m[1]!, expr: onLine(st.line, () => parseExpr(m[2]!)), line: st.line, ...label });
				break;
			}
			case "ode": {
				const states: Array<{ name: string; rhs: Expr; init?: Expr }> = [];
				const aux: Array<{ name: string; expr: Expr }> = [];
				const inits = new Map<string, Expr>();
				for (const part of splitTopLevel(body)) {
					let m: RegExpExecArray | null;
					if ((m = /^([A-Za-z_][A-Za-z0-9_]*)'\s*=\s*(.+)$/.exec(part))) states.push({ name: m[1]!, rhs: onLine(st.line, () => parseExpr(m![2]!), `${m[1]}'`) });
					else if ((m = /^([A-Za-z_][A-Za-z0-9_]*)\(\s*0\s*\)\s*=\s*(.+)$/.exec(part))) inits.set(m[1]!, onLine(st.line, () => parseExpr(m![2]!), `${m[1]}(0)`));
					else if ((m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(part))) aux.push({ name: m[1]!, expr: onLine(st.line, () => parseExpr(m![2]!), m[1]) });
					else throw new FigureError(st.line, `ode parts are "x' = …", "x(0) = …" or "u = …", got "${part}"`);
				}
				if (states.length === 0) throw new FigureError(st.line, "ode needs at least one \"x' = …\"");
				for (const name of inits.keys()) if (!states.some((s) => s.name === name)) throw new FigureError(st.line, `"${name}(0)" is not a state of this ode`);
				items.push({ kind: "ode", states: states.map((s) => ({ ...s, init: inits.get(s.name) ?? { k: "num", v: 0 } })), aux, line: st.line, ...label });
				break;
			}
			case "response": {
				const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s+to\s+(.+)$/.exec(body);
				if (!m) throw new FigureError(st.line, 'response must be "response <diagram id> <signal> to <excitation>", e.g. "response loop1 y to step r"');
				const ex = parseExcitation(m[3]!);
				if (typeof ex === "string") throw new FigureError(st.line, ex);
				items.push({ kind: "response", figure: m[1]!, signal: m[2]!, excitation: m[3]!, line: st.line, ...label });
				break;
			}
			case "transient": {
				const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s+((?:V|I)\(.+\))$/.exec(body);
				if (!m) throw new FigureError(st.line, 'transient must be "transient <circuit id> V(node)" (or V(a,b), I(element)), e.g. "transient c1 V(c)"');
				items.push({ kind: "transient", figure: m[1]!, what: m[2]!.replace(/\s+/g, ""), line: st.line, ...label });
				break;
			}
			case "samples": {
				const parts = splitTopLevel(body);
				const fs = parts.length === 2 ? /^fs\s*=\s*(\d*\.?\d+)$/.exec(parts[1]!) : null;
				if (!fs || !(Number(fs[1]) > 0)) throw new FigureError(st.line, 'samples must be "samples <expression>, fs = <rate>", e.g. "samples sin(2*pi*3*t), fs = 8"');
				items.push({ kind: "samples", expr: onLine(st.line, () => parseExpr(parts[0]!)), fs: Number(fs[1]), line: st.line, ...label });
				break;
			}
			case "mark": {
				const pt = /^point\s*\(\s*([^,]+),\s*([^)]+)\)$/.exec(body);
				const ax = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(body);
				const value = (src: string) => onLine(st.line, () => evaluate(parseExpr(src), paramValues(params)));
				if (pt) items.push({ kind: "mark", axis: "point", at: [value(pt[1]!), value(pt[2]!)], line: st.line, ...label });
				else if (ax && (ax[1] === spec!.x.name || ax[1] === spec!.y.name)) {
					items.push({ kind: "mark", axis: ax[1] === spec!.x.name ? "x" : "y", at: value(ax[2]!), line: st.line, ...label });
				} else throw new FigureError(st.line, `mark must be "mark ${spec!.x.name} = …", "mark ${spec!.y.name} = …" or "mark point (x, y)"`);
				break;
			}
		}
	}
	if (!spec) throw new FigureError(1, 'a plot starts with "axes", e.g. "axes t 0..10, y"');
	if (xlabel !== undefined) spec.x.label = xlabel;
	if (!items.some((i) => i.kind !== "mark")) throw new FigureError(sts.at(-1)?.line ?? 1, "the plot has nothing to draw — add a curve, ode, response or samples line");

	// every free name is the x variable, a parameter, an ode state or an ode input
	const vars = paramValues(params);
	for (const it of items) {
		const known = new Set([spec.x.name, ...Object.keys(vars)]);
		const exprs: Expr[] = [];
		if (it.kind === "curve" || it.kind === "samples") exprs.push(it.expr);
		if (it.kind === "ode") {
			for (const s of it.states) known.add(s.name);
			for (const a of it.aux) known.add(a.name);
			exprs.push(...it.states.map((s) => s.rhs), ...it.aux.map((a) => a.expr));
		}
		for (const e of exprs)
			for (const n of freeVars(e)) if (!known.has(n)) throw new FigureError(it.line, `"${n}" has no value — add "param ${n} = …"`);
	}
	return spec;
}

function paramValues(params: PlotSpec["params"]): Record<string, number> {
	const vars: Record<string, number> = {};
	for (const p of params) vars[p.name] = onLine(p.line, () => evaluate(p.value, vars), p.name);
	return vars;
}

// ─── computing ───────────────────────────────────────────────────────────────

export interface PlotLine {
	/** The name a check refers to (curve name, ode state, `<id>.<signal>`). */
	name?: string;
	label?: string;
	style: "line" | "stems" | "faint";
	x: number[];
	y: number[];
}
export interface PlotData {
	spec: PlotSpec;
	lines: PlotLine[];
	marks: Array<Extract<PlotItem, { kind: "mark" }>>;
}

/** Figures a plot can reference, by id (same question/message): block
 *  diagrams (response) and circuits (transient). */
export type DiagramScope = ReadonlyMap<string, { lang: string; source: string }>;

const CURVE_POINTS = 600;
const ODE_STEPS = 4000;
const DRAW_POINTS = 1000;

const thin = (x: ArrayLike<number>, y: ArrayLike<number>, a: number, b: number) => {
	const xs: number[] = [];
	const ys: number[] = [];
	const n = x.length;
	const stride = Math.max(1, Math.floor(n / DRAW_POINTS));
	for (let i = 0; i < n; i++) {
		if (x[i]! < a - 1e-12 || x[i]! > b + 1e-12) continue;
		if (i % stride !== 0 && i !== n - 1) continue;
		xs.push(x[i]!);
		ys.push(y[i]!);
	}
	return { x: xs, y: ys };
};

/** Compute every line of a parsed plot. Throws FigureError on a missing
 *  reference or a value that is not a finite number. */
export function computePlot(spec: PlotSpec, scope: DiagramScope = new Map()): PlotData {
	const vars = paramValues(spec.params);
	const [a, b] = spec.x.range;
	const xn = spec.x.name;
	const lines: PlotLine[] = [];
	const finite = (ys: number[], line: number) => {
		if (ys.some((v) => !Number.isFinite(v))) throw new FigureError(line, "the curve is not a finite number everywhere on the x range (division by zero, a log of a negative, or a blow-up)");
	};
	const label = (it: { label?: string }) => (it.label !== undefined ? { label: it.label } : {});
	for (const it of spec.items) {
		if (it.kind === "curve") {
			const x = Array.from({ length: CURVE_POINTS + 1 }, (_, i) => a + ((b - a) * i) / CURVE_POINTS);
			const y = x.map((xv) => onLine(it.line, () => evaluate(it.expr, { ...vars, [xn]: xv })));
			finite(y, it.line);
			lines.push({ name: it.name, style: "line", x, y, ...label(it) });
		} else if (it.kind === "samples") {
			const x = Array.from({ length: CURVE_POINTS + 1 }, (_, i) => a + ((b - a) * i) / CURVE_POINTS);
			const y = x.map((xv) => onLine(it.line, () => evaluate(it.expr, { ...vars, [xn]: xv })));
			finite(y, it.line);
			lines.push({ style: "faint", x, y });
			const sx: number[] = [];
			for (let k = Math.ceil(a * it.fs - 1e-9); k / it.fs <= b + 1e-9; k++) sx.push(k / it.fs);
			const sy = sx.map((xv) => evaluate(it.expr, { ...vars, [xn]: xv }));
			lines.push({ style: "stems", x: sx, y: sy, ...label(it) });
		} else if (it.kind === "ode") {
			if (a < 0) throw new FigureError(it.line, "an ode starts at 0 — the x range cannot start below 0");
			const h = b / ODE_STEPS;
			const env = (x: number, s: Float64Array): Record<string, number> => {
				const v: Record<string, number> = { ...vars, [xn]: x };
				it.states.forEach((st, i) => (v[st.name] = s[i]!));
				for (const ax of it.aux) v[ax.name] = evaluate(ax.expr, v);
				return v;
			};
			const f = (x: number, s: Float64Array) => {
				const v = env(x, s);
				return Float64Array.from(it.states.map((st) => evaluate(st.rhs, v)));
			};
			let s = onLine(it.line, () => Float64Array.from(it.states.map((st) => evaluate(st.init, vars))));
			const xs = new Float64Array(ODE_STEPS + 1);
			const ys = new Float64Array(ODE_STEPS + 1);
			ys[0] = s[0]!;
			onLine(it.line, () => {
				for (let k = 1; k <= ODE_STEPS; k++) {
					const x0 = (k - 1) * h;
					const k1 = f(x0, s);
					const k2 = f(x0 + h / 2, s.map((v, i) => v + (h / 2) * k1[i]!));
					const k3 = f(x0 + h / 2, s.map((v, i) => v + (h / 2) * k2[i]!));
					const k4 = f(x0 + h, s.map((v, i) => v + h * k3[i]!));
					s = s.map((v, i) => v + (h / 6) * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!));
					xs[k] = k * h;
					ys[k] = s[0]!;
				}
			});
			const drawn = thin(xs, ys, a, b);
			finite(drawn.y, it.line);
			lines.push({ name: it.states[0]!.name, style: "line", ...drawn, ...label(it) });
		} else if (it.kind === "response") {
			const ref = scope.get(it.figure);
			if (ref === undefined || ref.lang !== "blocks") throw new FigureError(it.line, `no block diagram with id=${it.figure} in this question — give the diagram's fence "id=${it.figure}"`);
			const src = ref.source;
			let d: BlockDiagram;
			try {
				d = parseBlocks(src);
			} catch (err) {
				throw new FigureError(it.line, `the diagram ${it.figure} does not parse (${err instanceof Error ? err.message : String(err)})`);
			}
			const why = notSimulatable(d);
			if (why) throw new FigureError(it.line, `the diagram ${it.figure} cannot simulate: ${why}`);
			if (!d.blocks.some((bl) => bl.out === it.signal)) throw new FigureError(it.line, `the diagram ${it.figure} has no signal "${it.signal}"`);
			if (a < 0) throw new FigureError(it.line, "a response starts at 0 — the x range cannot start below 0");
			const ex = parseExcitation(it.excitation);
			if (typeof ex === "string") throw new FigureError(it.line, ex);
			let sim;
			try {
				sim = simulate(d, [ex], b);
			} catch (err) {
				throw new FigureError(it.line, err instanceof Error ? err.message : String(err));
			}
			const drawn = thin(sim.t, sim.signals[it.signal]!, a, b);
			finite(drawn.y, it.line);
			lines.push({ name: `${it.figure}.${it.signal}`, style: "line", ...drawn, ...label(it) });
		} else if (it.kind === "transient") {
			const ref = scope.get(it.figure);
			if (ref === undefined || ref.lang !== "circuit") throw new FigureError(it.line, `no circuit with id=${it.figure} in this question — give the circuit's fence "id=${it.figure}"`);
			if (a < 0) throw new FigureError(it.line, "a transient starts at 0 — the x range cannot start below 0");
			let series;
			try {
				series = transientSeries(parseCircuit(ref.source), it.what, b);
			} catch (err) {
				throw new FigureError(it.line, `the circuit ${it.figure}: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (typeof series === "string") throw new FigureError(it.line, series);
			const drawn = thin(series.t, series.y, a, b);
			finite(drawn.y, it.line);
			lines.push({ name: `${it.figure}.${it.what}`, style: "line", ...drawn, ...label(it) });
		}
	}
	return { spec, lines, marks: spec.items.filter((i): i is Extract<PlotItem, { kind: "mark" }> => i.kind === "mark") };
}

