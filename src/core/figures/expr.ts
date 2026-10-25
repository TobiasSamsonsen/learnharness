/**
 * Figure expressions (figures phase 1, owner 2026-10-26). PURE,
 * browser-safe. The math every figure family shares: a tokenizer and a
 * Pratt parser to an AST, numeric evaluation, LaTeX for the drawing, and
 * the rational-in-s builder transfer-function blocks need.
 *
 * Never `eval`: the source is model-written text that also reaches the
 * learner's screen. Syntax: + - * / ^ (right-associative, binds tighter
 * than unary minus), parentheses, explicit `*` only, calls from FUNCS,
 * the constants `pi` and `e`.
 */

export type Expr =
	| { k: "num"; v: number }
	| { k: "var"; name: string }
	| { k: "neg"; a: Expr }
	| { k: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Expr; b: Expr }
	| { k: "call"; fn: string; args: Expr[] };

/** A parse or evaluation error; `col` is 1-based within the expression. */
export class ExprError extends Error {
	constructor(
		message: string,
		readonly col?: number,
	) {
		super(message);
	}
}

const FUNCS: Record<string, { arity: number; f: (...x: number[]) => number }> = {
	sin: { arity: 1, f: Math.sin },
	cos: { arity: 1, f: Math.cos },
	tan: { arity: 1, f: Math.tan },
	exp: { arity: 1, f: Math.exp },
	ln: { arity: 1, f: Math.log },
	log10: { arity: 1, f: Math.log10 },
	sqrt: { arity: 1, f: Math.sqrt },
	abs: { arity: 1, f: Math.abs },
	sign: { arity: 1, f: Math.sign },
	step: { arity: 1, f: (x) => (x >= 0 ? 1 : 0) },
	min: { arity: 2, f: Math.min },
	max: { arity: 2, f: Math.max },
};

export const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Names a parameter may not take (functions and constants). */
export function isReservedName(name: string): boolean {
	return name in FUNCS || name in CONSTANTS;
}

export function isFunctionName(name: string): boolean {
	return name in FUNCS;
}

// ─── tokens ──────────────────────────────────────────────────────────────────

type Tok = { t: "num"; v: number; col: number } | { t: "id"; v: string; col: number } | { t: "op"; v: string; col: number };

function tokenize(src: string): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i]!;
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
		if (num) {
			out.push({ t: "num", v: Number(num[0]), col: i + 1 });
			i += num[0].length;
			continue;
		}
		const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
		if (id) {
			out.push({ t: "id", v: id[0], col: i + 1 });
			i += id[0].length;
			continue;
		}
		if ("+-*/^(),".includes(c)) {
			out.push({ t: "op", v: c, col: i + 1 });
			i++;
			continue;
		}
		throw new ExprError(`unexpected character "${c}"`, i + 1);
	}
	return out;
}

// ─── parser ──────────────────────────────────────────────────────────────────

const BINARY: Record<string, { prec: number; right: boolean }> = {
	"+": { prec: 1, right: false },
	"-": { prec: 1, right: false },
	"*": { prec: 2, right: false },
	"/": { prec: 2, right: false },
	"^": { prec: 4, right: true },
};
const UNARY_PREC = 3;

export function parseExpr(src: string): Expr {
	const toks = tokenize(src);
	let pos = 0;
	const peek = () => toks[pos];
	const endCol = src.length + 1;

	function primary(): Expr {
		const tok = toks[pos++];
		if (!tok) throw new ExprError("expression ends too early", endCol);
		if (tok.t === "num") return { k: "num", v: tok.v };
		if (tok.t === "id") {
			const next = peek();
			if (next?.t === "op" && next.v === "(") {
				const fn = FUNCS[tok.v];
				if (!fn) throw new ExprError(`unknown function "${tok.v}" (known: ${Object.keys(FUNCS).join(", ")})`, tok.col);
				pos++;
				const args: Expr[] = [];
				if (!(peek()?.t === "op" && peek()!.v === ")")) {
					args.push(expression(0));
					while (peek()?.t === "op" && peek()!.v === ",") {
						pos++;
						args.push(expression(0));
					}
				}
				const close = toks[pos++];
				if (!(close?.t === "op" && close.v === ")")) throw new ExprError(`missing ")" after the arguments of ${tok.v}`, close?.col ?? endCol);
				if (args.length !== fn.arity) throw new ExprError(`${tok.v} takes ${fn.arity} argument${fn.arity === 1 ? "" : "s"}, got ${args.length}`, tok.col);
				return { k: "call", fn: tok.v, args };
			}
			return { k: "var", name: tok.v };
		}
		if (tok.v === "(") {
			const inner = expression(0);
			const close = toks[pos++];
			if (!(close?.t === "op" && close.v === ")")) throw new ExprError('missing ")"', close?.col ?? endCol);
			return inner;
		}
		if (tok.v === "-") return { k: "neg", a: expression(UNARY_PREC) };
		if (tok.v === "+") return expression(UNARY_PREC);
		throw new ExprError(`unexpected "${tok.v}"`, tok.col);
	}

	function expression(minPrec: number): Expr {
		let left = primary();
		for (;;) {
			const tok = peek();
			if (!tok) break;
			if (tok.t !== "op") throw new ExprError(`missing operator before "${tok.v}" (write * explicitly)`, tok.col);
			const info = BINARY[tok.v];
			if (!info || info.prec < minPrec) break;
			pos++;
			const right = expression(info.right ? info.prec : info.prec + 1);
			left = { k: "bin", op: tok.v as "+" | "-" | "*" | "/" | "^", a: left, b: right };
		}
		return left;
	}

	const ast = expression(0);
	const rest = peek();
	if (rest) throw new ExprError(`unexpected "${rest.v}"`, rest.col);
	return ast;
}

// ─── evaluation ──────────────────────────────────────────────────────────────

export function freeVars(ast: Expr, out = new Set<string>()): Set<string> {
	if (ast.k === "var") {
		if (!(ast.name in CONSTANTS)) out.add(ast.name);
	} else if (ast.k === "neg") freeVars(ast.a, out);
	else if (ast.k === "bin") {
		freeVars(ast.a, out);
		freeVars(ast.b, out);
	} else if (ast.k === "call") for (const a of ast.args) freeVars(a, out);
	return out;
}

export function evaluate(ast: Expr, vars: Readonly<Record<string, number>>): number {
	switch (ast.k) {
		case "num":
			return ast.v;
		case "var": {
			const v = vars[ast.name] ?? CONSTANTS[ast.name];
			if (v === undefined) throw new ExprError(`"${ast.name}" has no value`);
			return v;
		}
		case "neg":
			return -evaluate(ast.a, vars);
		case "bin": {
			const a = evaluate(ast.a, vars);
			const b = evaluate(ast.b, vars);
			if (ast.op === "+") return a + b;
			if (ast.op === "-") return a - b;
			if (ast.op === "*") return a * b;
			if (ast.op === "/") return a / b;
			return a ** b;
		}
		case "call":
			return FUNCS[ast.fn]!.f(...ast.args.map((x) => evaluate(x, vars)));
	}
}

// ─── LaTeX ───────────────────────────────────────────────────────────────────

const GREEK = new Set([
	"alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "kappa", "lambda", "mu", "nu", "xi", "rho", "sigma", "tau", "phi",
	"chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda", "Sigma", "Phi", "Psi", "Omega",
]);

/** An identifier as LaTeX: Greek names become symbols, `_` starts a
 *  subscript (`K_p` → K_{p}, `omega_0` → \omega_{0}). */
export function identLatex(name: string): string {
	const [head, ...subs] = name.split("_");
	const base = GREEK.has(head!) ? `\\${head}` : head!.length > 1 ? `\\mathrm{${head}}` : head!;
	return subs.length > 0 && subs.join("_") !== "" ? `${base}_{${subs.map((s) => (GREEK.has(s) ? `\\${s}` : s)).join(",")}}` : base;
}

function numLatex(v: number): string {
	return String(Number(v.toPrecision(10)));
}

const PREC: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 4 };
const precOf = (e: Expr): number => (e.k === "bin" ? PREC[e.op]! : e.k === "neg" ? UNARY_PREC : 9);

export function toLatex(ast: Expr): string {
	switch (ast.k) {
		case "num":
			return numLatex(ast.v);
		case "var":
			return ast.name in CONSTANTS ? (ast.name === "pi" ? "\\pi" : "e") : identLatex(ast.name);
		case "neg": {
			const inner = toLatex(ast.a);
			return precOf(ast.a) <= 1 ? `-\\left(${inner}\\right)` : `-${inner}`;
		}
		case "call": {
			const args = ast.args.map(toLatex);
			if (ast.fn === "exp") return `e^{${args[0]}}`;
			if (ast.fn === "sqrt") return `\\sqrt{${args[0]}}`;
			if (ast.fn === "abs") return `\\left|${args[0]}\\right|`;
			const name = ["sin", "cos", "tan", "ln", "min", "max"].includes(ast.fn) ? `\\${ast.fn}` : `\\operatorname{${ast.fn}}`;
			return `${name}\\left(${args.join(", ")}\\right)`;
		}
		case "bin": {
			const wrap = (e: Expr, need: boolean) => (need ? `\\left(${toLatex(e)}\\right)` : toLatex(e));
			// -t/T parses as (-t)/T; textbooks write the minus outside
			if (ast.op === "/") return ast.a.k === "neg" ? `-\\frac{${toLatex(ast.a.a)}}{${toLatex(ast.b)}}` : `\\frac{${toLatex(ast.a)}}{${toLatex(ast.b)}}`;
			if (ast.op === "^") return `${wrap(ast.a, precOf(ast.a) <= 4)}^{${toLatex(ast.b)}}`;
			if (ast.op === "*") {
				const a = wrap(ast.a, precOf(ast.a) < 2);
				const b = wrap(ast.b, precOf(ast.b) < 2 || ast.b.k === "neg");
				// a number next to a number needs a visible dot; otherwise juxtapose
				const dot = ast.b.k === "num" || (/\d$/.test(a) && /^\d/.test(b));
				return dot ? `${a} \\cdot ${b}` : `${a}\\,${b}`;
			}
			const b = wrap(ast.b, ast.op === "-" && precOf(ast.b) <= 1);
			return `${toLatex(ast.a)} ${ast.op} ${b}`;
		}
	}
}

// ─── rational functions in s (transfer functions) ────────────────────────────

/** Polynomial coefficients, ascending powers (p[0] + p[1]s + …). */
export type Poly = number[];
export interface Rational {
	num: Poly;
	den: Poly;
}

const trim = (p: Poly): Poly => {
	const q = [...p];
	while (q.length > 1 && Math.abs(q[q.length - 1]!) < 1e-14) q.pop();
	return q;
};
const padd = (a: Poly, b: Poly): Poly => trim(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0)));
const pscale = (a: Poly, k: number): Poly => trim(a.map((x) => x * k));
const pmul = (a: Poly, b: Poly): Poly => {
	const out = new Array<number>(a.length + b.length - 1).fill(0);
	a.forEach((x, i) => b.forEach((y, j) => (out[i + j]! += x * y)));
	return trim(out);
};
export const degree = (p: Poly): number => trim(p).length - 1;

/** The expression as a rational function of `s`, every other name taken
 *  from `vars`. Functions are allowed only in s-free subtrees; `^` needs
 *  a non-negative integer exponent. The result is monic in its
 *  denominator. */
export function toRational(ast: Expr, vars: Readonly<Record<string, number>>, sName = "s"): Rational {
	const build = (e: Expr): Rational => {
		if (!freeVars(e).has(sName)) return { num: [evaluate(e, vars)], den: [1] };
		switch (e.k) {
			case "var":
				return { num: [0, 1], den: [1] };
			case "neg": {
				const a = build(e.a);
				return { num: pscale(a.num, -1), den: a.den };
			}
			case "bin": {
				const a = build(e.a);
				if (e.op === "^") {
					const n = freeVars(e.b).has(sName) ? NaN : evaluate(e.b, vars);
					if (!Number.isInteger(n) || n < 0) throw new ExprError(`a power of an expression in ${sName} needs a whole, non-negative exponent`);
					let out: Rational = { num: [1], den: [1] };
					for (let i = 0; i < n; i++) out = { num: pmul(out.num, a.num), den: pmul(out.den, a.den) };
					return out;
				}
				const b = build(e.b);
				if (e.op === "*") return { num: pmul(a.num, b.num), den: pmul(a.den, b.den) };
				if (e.op === "/") return { num: pmul(a.num, b.den), den: pmul(a.den, b.num) };
				const sign = e.op === "-" ? -1 : 1;
				return { num: padd(pmul(a.num, b.den), pscale(pmul(b.num, a.den), sign)), den: pmul(a.den, b.den) };
			}
			case "call":
				throw new ExprError(`${e.fn}() of ${sName} is not a rational function`);
			default:
				throw new ExprError("not a rational function");
		}
	};
	const r = build(ast);
	const den = trim(r.den);
	const lead = den[den.length - 1]!;
	if (Math.abs(lead) < 1e-14) throw new ExprError("the denominator is zero");
	return { num: pscale(trim(r.num), 1 / lead), den: pscale(den, 1 / lead) };
}
