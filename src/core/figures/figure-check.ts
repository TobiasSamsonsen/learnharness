/**
 * Figures in questions (figures phase 1, owner 2026-10-26). PURE.
 *
 *   - figureFences: the ```plot / ```blocks fences of a markdown text.
 *   - figureProblems: every figure of a question parsed (and computed)
 *     BEFORE it is posed — the author gets the exact line and problem.
 *   - judgeFigureCheck: the optional hidden `figureCheck` ({figure,
 *     quantity}) computed and compared to the correct option's number.
 *   - figureFacts: what the figures compute, as sentences for the blind
 *     second model (server/question-check.ts).
 *
 * A question's figures share one scope: a plot anywhere in the stem,
 * details, options or explanation may reference a diagram by its id.
 */

import { evaluate, parseExpr } from "./expr.ts";
import { notSimulatable, parseBlocks, parseExcitation, simulate, type BlockDiagram, type Excitation } from "./blocks.ts";
import { computePlot, parsePlot, type DiagramScope } from "./plot.ts";
import { FigureError } from "./lines.ts";
import { circuitFacts, circuitQuantity, parseCircuit } from "./circuit.ts";
import { computeTiming, logicFacts, logicQuantity, parseLogic, parseTiming } from "./logic.ts";
import { METRICS, metric, valueAt, type Metric, type Series } from "./metrics.ts";

export type FigureLang = "plot" | "blocks" | "circuit" | "logic" | "timing";
export const FIGURE_LANGS: readonly FigureLang[] = ["plot", "blocks", "circuit", "logic", "timing"];

export interface FigureFence {
	lang: FigureLang;
	id?: string;
	source: string;
}

/** The figure fences of one markdown text, in order. */
export function figureFences(text: string): FigureFence[] {
	const out: FigureFence[] = [];
	// a fence opens and closes at the start of a line (markdown's rule) — a
	// ```plot mentioned inside prose is not a figure
	for (const m of text.matchAll(/(?:^|\n)[ \t]*```(plot|blocks|circuit|logic|timing)([^\n`]*)\r?\n([\s\S]*?)\r?\n[ \t]*```/g)) {
		const id = /\bid\s*=\s*([A-Za-z0-9_-]+)/.exec(m[2]!)?.[1];
		out.push({ lang: m[1] as FigureLang, source: m[3]!, ...(id ? { id } : {}) });
	}
	return out;
}

/** The fence meta's id (`id=loop1`), for the renderer. */
export function fenceId(meta: string): string | undefined {
	return /\bid\s*=\s*([A-Za-z0-9_-]+)/.exec(meta)?.[1];
}

/** The figures another figure may reference by id: diagrams and circuits
 *  (plots), logic diagrams (timing). */
export function diagramScope(texts: readonly string[]): Map<string, { lang: FigureLang; source: string }> {
	const scope = new Map<string, { lang: FigureLang; source: string }>();
	for (const f of texts.flatMap(figureFences)) if ((f.lang === "blocks" || f.lang === "circuit" || f.lang === "logic") && f.id) scope.set(f.id, { lang: f.lang, source: f.source });
	return scope;
}

/** The logic source a timing figure links to, from a scope. */
export function logicOf(scope: DiagramScope): (id: string) => string | undefined {
	return (id) => {
		const ref = scope.get(id);
		return ref?.lang === "logic" ? ref.source : undefined;
	};
}

const where = (f: FigureFence, i: number) => `Figure ${i + 1} (\`\`\`${f.lang}${f.id ? ` id=${f.id}` : ""})`;

/** Parse (and compute) one figure; throws FigureError. */
export function checkFigure(f: FigureFence, scope: DiagramScope): void {
	if (f.lang === "blocks") parseBlocks(f.source);
	else if (f.lang === "circuit") parseCircuit(f.source);
	else if (f.lang === "logic") parseLogic(f.source);
	else if (f.lang === "timing") {
		const t = parseTiming(f.source);
		if (t.logic) computeTiming(t, logicOf(scope)(t.logic));
	} else computePlot(parsePlot(f.source), scope);
}

/** Author-facing problems with the figures of a question's fields
 *  (empty = every figure parses, computes and resolves). */
export function figureProblems(fields: readonly string[]): string[] {
	const figures = fields.flatMap(figureFences);
	if (figures.length === 0) return [];
	const problems: string[] = [];
	const ids = new Map<string, number>();
	figures.forEach((f, i) => {
		if (!f.id) return;
		if (ids.has(f.id)) problems.push(`${where(f, i)}: id=${f.id} is used twice in this question (also figure ${ids.get(f.id)! + 1}) — ids must be unique`);
		else ids.set(f.id, i);
	});
	const scope = diagramScope(fields);
	figures.forEach((f, i) => {
		try {
			checkFigure(f, scope);
		} catch (err) {
			const msg = err instanceof FigureError ? `line ${err.line}: ${err.message}` : err instanceof Error ? err.message : String(err);
			problems.push(`${where(f, i)} ${msg}. (figure_guide has the ${f.lang} syntax.)`);
		}
	});
	return problems;
}

/** Every string inside a tool input (question, options, explanation,
 *  solution, …) — the fields a question's figures may live in. */
export function inputTexts(input: unknown, out: string[] = []): string[] {
	if (typeof input === "string") out.push(input);
	else if (Array.isArray(input)) for (const v of input) inputTexts(v, out);
	else if (input && typeof input === "object") for (const v of Object.values(input)) inputTexts(v, out);
	return out;
}

/** figureProblems over a whole tool input (the question tools' gate).
 *  `perField`: each text is its own scope — practice problems, whose
 *  statement and solution render as separate cards. */
export function figureInputProblems(input: unknown, opts: { perField?: boolean } = {}): string[] {
	const texts = inputTexts(input).filter((t) => t.includes("```"));
	if (texts.length === 0) return [];
	return opts.perField ? texts.flatMap((t) => figureProblems([t])) : figureProblems(texts);
}

// ─── quantities ──────────────────────────────────────────────────────────────

export interface FigureCheck {
	figure: string;
	quantity: string;
	/** Blocks only: the excitation ("step r"); default a unit step on the first input. */
	input?: string;
}

/** The series a quantity is read from, by name. */
function seriesOf(texts: readonly string[], check: FigureCheck, name: string): Series | string {
	const fig = texts.flatMap(figureFences).find((f) => f.id === check.figure);
	if (!fig) return `figureCheck names figure "${check.figure}", but no figure in the question has id=${check.figure}`;
	if (fig.lang === "blocks") {
		let d: BlockDiagram;
		try {
			d = parseBlocks(fig.source);
		} catch (err) {
			return `the diagram ${check.figure} does not parse: ${err instanceof Error ? err.message : String(err)}`;
		}
		const why = notSimulatable(d);
		if (why) return `figureCheck needs a simulatable diagram: ${why}`;
		const ex = excitationFor(d, check.input);
		if (typeof ex === "string") return ex;
		if (!d.blocks.some((b) => b.out === name)) return `the diagram ${check.figure} has no signal "${name}"`;
		const sim = simulate(d, [ex]);
		return { t: sim.t, y: sim.signals[name]! };
	}
	const data = computePlot(parsePlot(fig.source), diagramScope(texts));
	const line = data.lines.find((l) => l.name === name && l.style === "line");
	if (!line) {
		const names = data.lines.filter((l) => l.name && l.style === "line").map((l) => l.name);
		return `the plot ${check.figure} has no curve "${name}" (its curves: ${names.join(", ") || "none"})`;
	}
	return { t: line.x, y: line.y };
}

function excitationFor(d: BlockDiagram, input?: string): Excitation | string {
	if (input) return parseExcitation(input);
	const first = d.blocks.find((b) => b.kind === "input");
	return first ? { kind: "step", input: first.out } : "the diagram has no input to excite";
}

/** A quantity's value: `metric(name)` or `name(<x>=<value>)`. */
export function figureQuantity(texts: readonly string[], check: FigureCheck): number | string {
	const q = check.quantity.trim();
	// a circuit answers circuit quantities (V(b), I(R1), R(a,b), tau(V(c)), …)
	const fig = texts.flatMap(figureFences).find((f) => f.id === check.figure);
	if (fig?.lang === "logic" || fig?.lang === "timing") return logicQuantity(fig.lang, fig.source, q, logicOf(diagramScope(texts)));
	if (fig?.lang === "circuit") {
		try {
			return circuitQuantity(parseCircuit(fig.source), q);
		} catch (err) {
			return `the circuit ${check.figure} does not parse: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
	const mm = /^([a-z]+)\(\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\)$/.exec(q);
	const vm = /^([A-Za-z_][A-Za-z0-9_.-]*)\(\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*\)$/.exec(q);
	if (mm && METRICS.includes(mm[1] as Metric)) {
		const s = seriesOf(texts, check, mm[2]!);
		return typeof s === "string" ? s : metric(s, mm[1] as Metric);
	}
	if (vm) {
		const s = seriesOf(texts, check, vm[1]!);
		return typeof s === "string" ? s : valueAt(s, Number(vm[2]));
	}
	return `figureCheck.quantity "${q}" is not one of: ${METRICS.map((m) => `${m}(y)`).join(", ")}, or y(t=2)`;
}

// ─── option numbers ──────────────────────────────────────────────────────────

/** The numbers an option label states (LaTeX understood: {,} decimal
 *  comma, \frac, \sqrt, \pi, \cdot; subscripts ignored; % dropped). */
// as powers of ten — the number scanner below reads digits, operators and parentheses only
const SI_SCALE: Record<string, string> = { p: "10^(-12)", n: "10^(-9)", u: "10^(-6)", "µ": "10^(-6)", "μ": "10^(-6)", m: "10^(-3)", k: "10^3", M: "10^6", G: "10^9" };

export function labelNumbers(label: string): number[] {
	let s = label.replace(/\$+/g, " ").replace(/\\(?:left|right)\b/g, "").replace(/\\Omega\b/g, "Ω").replace(/\\(?:mu|micro)\b/g, "µ");
	s = s.replace(/\{,\}/g, ".").replace(/(\d),(\d)/g, "$1.$2");
	s = s.replace(/_\{[^{}]*\}|_[A-Za-z0-9]/g, "");
	s = s.replace(/\\[,;:! ]/g, "").replace(/\\(?:cdot|times)/g, "*").replace(/\\pi\b/g, "pi");
	for (let prev = ""; prev !== s; ) {
		prev = s;
		s = s.replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)").replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, "(($1)/($2))").replace(/\^\{([^{}]*)\}/g, "^($1)");
	}
	s = s.replace(/\\?%/g, " ").replace(/\\[A-Za-z]+/g, " ").replace(/[{}]/g, "");
	// a number with an SI prefix before a unit counts scaled: 2.5 mA → (2.5*1e-3)
	s = s.replace(/(\d+(?:\.\d+)?)\s*(p|n|u|µ|μ|m|k|M|G)(?=\s*(?:V|A|Ω|F|H|W|Hz|s|ohm)(?![A-Za-z]))/g, (_m, n: string, p: string) => `(${n}*${SI_SCALE[p]})`);
	s = s.replace(/(\d|\))\s*(?=sqrt|pi|\()/g, "$1*");
	const out: number[] = [];
	for (const m of s.matchAll(/[-+]?\s*(?:\d|\.\d|\(|pi|sqrt)(?:[\d.+\-*/^()\s]|pi|sqrt)*/g)) {
		const src = m[0].trim().replace(/[\s+\-*/^(]+$/, "");
		try {
			const v = evaluate(parseExpr(src), {});
			if (Number.isFinite(v)) out.push(v);
		} catch {
			// not a number expression — words, units, unbalanced parts
		}
	}
	return out;
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, 0.01 * Math.max(Math.abs(a), Math.abs(b)));
const fmt = (v: number) => String(Number(v.toPrecision(4)));

/** The figureCheck verdict: verified, or the author's problems. */
export function judgeFigureCheck(
	texts: readonly string[],
	options: ReadonlyArray<{ label: string }>,
	correct: readonly number[],
	check: FigureCheck,
): { verified: boolean; problems: string[] } {
	let value: number | string;
	try {
		value = figureQuantity(texts, check);
	} catch (err) {
		value = err instanceof Error ? err.message : String(err);
	}
	if (typeof value === "string") return { verified: false, problems: [`figureCheck: ${value}.`] };
	const keyed = correct.map((i) => options[i]!);
	const stated = keyed.flatMap((o) => labelNumbers(o.label));
	if (stated.length === 0) {
		return { verified: false, problems: [`figureCheck: the correct option ${keyed.map((o) => `"${o.label}"`).join(", ")} states no number to compare with ${check.quantity} — state the value in the option, or drop figureCheck.`] };
	}
	if (stated.some((n) => close(n, value))) return { verified: true, problems: [] };
	const matching = options.flatMap((o, i) => (!correct.includes(i) && labelNumbers(o.label).some((n) => close(n, value)) ? [`"${o.label}"`] : []));
	return {
		verified: false,
		problems: [
			`figureCheck computed ${check.quantity} = ${fmt(value)} from figure ${check.figure}, but the correct option states ${stated.map(fmt).join(", ")}` +
				(matching.length ? ` — that value is option ${matching.join(" / ")}` : "") +
				". Re-solve with the computed value and fix the key, the options or the figure, then call again.",
		],
	};
}

// ─── facts for the second model ──────────────────────────────────────────────

function metricSentence(s: Series): string {
	const parts: string[] = [];
	for (const m of ["steady", "overshoot", "settling", "rise", "tau", "peak"] as const) {
		const v = metric(s, m);
		if (typeof v === "string") return m === "steady" ? "has not settled by the end of the simulated time" : parts.join(", ");
		parts.push(`${m === "steady" ? "settles at" : m === "settling" ? "2 % settling time" : m === "rise" ? "10–90 % rise time" : m === "tau" ? "63 % time" : m} ${fmt(v)}${m === "overshoot" ? " %" : ""}`);
	}
	return parts.join(", ");
}

/** What the question's figures compute, as plain sentences. */
export function figureFacts(fields: readonly string[]): string[] {
	const facts: string[] = [];
	const scope = diagramScope(fields);
	fields.flatMap(figureFences).forEach((f, i) => {
		try {
			if (f.lang === "circuit") {
				for (const fact of circuitFacts(parseCircuit(f.source))) facts.push(`${where(f, i)} ${fact}.`);
			} else if (f.lang === "logic" || f.lang === "timing") {
				for (const fact of logicFacts(f.lang, f.source, logicOf(scope))) facts.push(`${where(f, i)} ${fact}.`);
			} else if (f.lang === "blocks") {
				const d = parseBlocks(f.source);
				if (notSimulatable(d)) return;
				const ex = excitationFor(d, undefined);
				if (typeof ex === "string") return;
				const sim = simulate(d, [ex]);
				for (const out of d.outputs) {
					facts.push(`${where(f, i)} simulated with a unit step on ${ex.input} over 0..${d.horizon}: output ${out} ${metricSentence({ t: sim.t, y: sim.signals[out]! })}.`);
				}
			} else {
				const data = computePlot(parsePlot(f.source), scope);
				for (const l of data.lines) {
					if (!l.name || l.style !== "line") continue;
					facts.push(`${where(f, i)} curve ${l.name}${l.label ? ` ("${l.label}")` : ""}: starts at ${fmt(l.y[0]!)}, ends at ${fmt(l.y[l.y.length - 1]!)}; ${metricSentence({ t: l.x, y: l.y })}.`);
				}
			}
		} catch {
			// an unparseable figure is figureProblems' business
		}
	});
	return facts;
}
