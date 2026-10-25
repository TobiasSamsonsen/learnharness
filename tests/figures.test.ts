/**
 * Figures phase 1 (owner, 2026-10-26): the core — expressions, block
 * diagrams + simulation, plots, metrics, and the question checks. The
 * simulator is pinned against closed-form answers from the Kyb course.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	diagramScope,
	evaluate,
	ExprError,
	figureFacts,
	figureFences,
	figureProblems,
	FigureError,
	judgeFigureCheck,
	labelNumbers,
	metric,
	parseBlocks,
	parseExpr,
	parsePlot,
	computePlot,
	simulate,
	toLatex,
	toRational,
	valueAt,
} from "../src/core/figures/index.ts";

const near = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

describe("expressions", () => {
	it("precedence: ^ binds tighter than unary minus, and is right-associative", () => {
		assert.equal(evaluate(parseExpr("-2^2"), {}), -4);
		assert.equal(evaluate(parseExpr("2^3^2"), {}), 512);
		assert.equal(evaluate(parseExpr("1 + 2*3 - 4/2"), {}), 5);
		near(evaluate(parseExpr("exp(-t/T)"), { t: 2, T: 2 }), Math.exp(-1), 1e-12);
		assert.equal(evaluate(parseExpr("step(t - 1)"), { t: 0.5 }), 0);
		near(evaluate(parseExpr("sin(2*pi*f*t)"), { f: 1, t: 0.25 }), 1, 1e-12);
	});

	it("errors name the problem and its column", () => {
		assert.throws(() => parseExpr("2 x"), (e: ExprError) => /write \* explicitly/.test(e.message) && e.col === 3);
		assert.throws(() => parseExpr("foo(1)"), /unknown function "foo"/);
		assert.throws(() => parseExpr("(1 + 2"), /missing "\)"/);
		assert.throws(() => evaluate(parseExpr("K*2"), {}), /"K" has no value/);
	});

	it("LaTeX for the drawing: fractions, subscripts, Greek, e^", () => {
		assert.equal(toLatex(parseExpr("K/(T*s + 1)")), "\\frac{K}{T\\,s + 1}");
		assert.equal(toLatex(parseExpr("K_p")), "K_{p}");
		assert.equal(toLatex(parseExpr("omega_0^2")), "\\omega_{0}^{2}");
		assert.equal(toLatex(parseExpr("exp(-t/T)")), "e^{-\\frac{t}{T}}");
		assert.equal(toLatex(parseExpr("2*3")), "2 \\cdot 3");
	});

	it("rational functions in s, monic denominator", () => {
		const r = toRational(parseExpr("K/(T*s + 1)"), { K: 2, T: 4 });
		assert.deepEqual(r, { num: [0.5], den: [0.25, 1] });
		const second = toRational(parseExpr("1/(s^2 + 2*z*w*s + w^2)"), { z: 0.5, w: 2 });
		assert.deepEqual(second.den, [4, 2, 1]);
		assert.throws(() => toRational(parseExpr("exp(s)"), {}), /not a rational function/);
	});
});

describe("block diagrams — parsing and validation", () => {
	const ploop = "param K = 2, T = 4, K_p = 1.5\ninput r\nsum e = r - y\ngain u = K_p * e\ntf y = K/(T*s + 1) * u\noutput y";

	it("parses the signal-flow form", () => {
		const d = parseBlocks(ploop);
		assert.deepEqual(d.blocks.map((b) => `${b.kind}:${b.out}`), ["input:r", "sum:e", "gain:u", "tf:y"]);
		assert.deepEqual(d.outputs, ["y"]);
		assert.deepEqual(d.symbols, []);
	});

	it("symbolic parameters draw but do not simulate", () => {
		const d = parseBlocks("input r\nsum e = r - y\ntf y = G * e\noutput y");
		assert.deepEqual(d.symbols, ["G"]);
		assert.throws(() => simulate(d, [{ kind: "step", input: "r" }]), /give every parameter a value/);
	});

	const err = (src: string, re: RegExp, line?: number) =>
		assert.throws(() => parseBlocks(src), (e: FigureError) => re.test(e.message) && (line === undefined || e.line === line));

	it("refuses undefined, doubly defined and unused signals with their line", () => {
		err("input r\ngain u = 2 * x\noutput u", /gain reads no signal of this diagram/, 2);
		err("input r\nsum e = r - x\noutput e", /signal "x" is never defined/, 2);
		err("input r\ngain u = 2 * r\ngain u = 3 * r\noutput u", /defined twice/, 3);
		err("input r\ngain u = 2 * r\ngain v = 3 * r\noutput u", /"v" is never used/, 3);
		err("input r\ngain u = 2 * r", /at least one "output/);
		err("input r\nwire u = r\noutput u", /unknown statement "wire"/, 2);
	});

	it("refuses an algebraic loop, accepts a loop broken by int or a strictly proper tf", () => {
		err("input r\nsum e = r - y\ngain y = 2 * e\noutput y", /algebraic loop through/);
		parseBlocks("input r\nsum e = r - y\nint y = e\noutput y");
		parseBlocks(ploop);
		err("param K = 1\ninput r\nsum e = r - y\ntf y = (s + 1)/(s + 2) * e\noutput y", /algebraic loop/);
	});

	it("refuses an improper tf and malformed blocks with a template", () => {
		err("input r\ntf y = (s^2 + 1)/(s + 1) * r\noutput y", /improper/);
		err("input r\ngain u = r + 1\noutput u", /gain must be "<factor> \* <signal>"/);
		err("input r\nsum e = r\noutput e", /two or more signed signals/);
		err("input r\npid u = r; K_p = 1, K_i = 2, T_d = 1\noutput u", /either K_p, T_i, T_d/);
	});
});

describe("block diagrams — simulation against closed forms", () => {
	it("first order: y = K(1 − e^{−t/T}); τ and steady read back", () => {
		const d = parseBlocks("param K = 3, T = 0.5\ninput u\ntf y = K/(T*s + 1) * u\noutput y\nsim 0..10");
		const sim = simulate(d, [{ kind: "step", input: "u" }]);
		const s = { t: sim.t, y: sim.signals.y! };
		near(valueAt(s, 0.5), 3 * (1 - Math.exp(-1)), 1e-6);
		near(metric(s, "steady") as number, 3, 1e-4);
		near(metric(s, "tau") as number, 0.5, 2e-3);
	});

	it("the Kyb P-loop: closed-loop time constant T/(1+K K_p) and steady state K K_p/(1+K K_p)", () => {
		const d = parseBlocks("param K = 2, T = 4, K_p = 1.5\ninput r\nsum e = r - y\ngain u = K_p * e\ntf y = K/(T*s + 1) * u\noutput y");
		const sim = simulate(d, [{ kind: "step", input: "r" }]);
		const s = { t: sim.t, y: sim.signals.y! };
		near(metric(s, "steady") as number, 0.75, 1e-4);
		near(metric(s, "tau") as number, 1, 5e-3);
		near(metric(sim.signals.e ? { t: sim.t, y: sim.signals.e } : s, "steady") as number, 0.25, 1e-4);
	});

	it("second order: overshoot e^{−πζ/√(1−ζ²)} within 0.5 %", () => {
		const zeta = 0.3;
		const w = 2;
		const d = parseBlocks(`param z = ${zeta}, w = ${w}\ninput r\ntf y = w^2/(s^2 + 2*z*w*s + w^2) * r\noutput y\nsim 0..30`);
		const sim = simulate(d, [{ kind: "step", input: "r" }]);
		const os = metric({ t: sim.t, y: sim.signals.y! }, "overshoot") as number;
		near(os, 100 * Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)), 0.5);
	});

	it("the same second-order loop built from integrators matches the tf", () => {
		const d = parseBlocks("param z = 0.3, w = 2\ninput r\nsum a = r - p - q\ngain b = w^2 * a\nint v = b\nint x = v\ngain p = 1 * x\ngain q = 2*z/w * v\noutput x\nsim 0..30");
		const sim = simulate(d, [{ kind: "step", input: "r" }]);
		near(metric({ t: sim.t, y: sim.signals.x! }, "overshoot") as number, 100 * Math.exp((-Math.PI * 0.3) / Math.sqrt(1 - 0.09)), 0.5);
	});

	it("PI removes the steady-state error; saturation clamps; a clamped integrator stops", () => {
		const pi = parseBlocks("param K = 2, T = 4\ninput r\nsum e = r - y\npid u = e; K_p = 1.5, T_i = 2\ntf y = K/(T*s + 1) * u\noutput y\nsim 0..60");
		const sim = simulate(pi, [{ kind: "step", input: "r" }]);
		near(metric({ t: sim.t, y: sim.signals.y! }, "steady") as number, 1, 1e-3);

		const sat = parseBlocks("input r\ngain u = 10 * r\nsat v = u in [-1, 1]\noutput v");
		near(simulate(sat, [{ kind: "step", input: "r" }]).signals.v!.at(-1)!, 1, 1e-12);

		const lim = parseBlocks("input r\nint x = r; limit [0, 2]\noutput x\nsim 0..10");
		near(simulate(lim, [{ kind: "step", input: "r" }]).signals.x!.at(-1)!, 2, 1e-12);
	});

	it("a delay shifts the response", () => {
		const d = parseBlocks("input r\ndelay z = r; 1.5\noutput z\nsim 0..4");
		const sim = simulate(d, [{ kind: "step", input: "r" }]);
		near(valueAt({ t: sim.t, y: sim.signals.z! }, 1.4), 0, 1e-9);
		near(valueAt({ t: sim.t, y: sim.signals.z! }, 1.6), 1, 1e-9);
	});
});

describe("plots", () => {
	it("curves, odes and samples compute; ode matches its closed form", () => {
		const data = computePlot(
			parsePlot('axes t 0..10, y "y(t)"\ncurve y = 1 - exp(-t/2) "T = 2"\node x\' = -x/2 + u/2, x(0) = 0, u = step(t)\nsamples sin(2*pi*0.3*t), fs = 2\nmark t = 2 "T"'),
		);
		const ode = data.lines.find((l) => l.name === "x")!;
		near(valueAt({ t: ode.x, y: ode.y }, 2), 1 - Math.exp(-1), 1e-4);
		assert.equal(data.lines.find((l) => l.style === "stems")!.x.length, 21);
		assert.equal(data.marks.length, 1);
	});

	it("a response resolves a diagram from the scope", () => {
		const scope = new Map([["loop1", "param K = 2, T = 4, K_p = 1.5\ninput r\nsum e = r - y\ngain u = K_p * e\ntf y = K/(T*s + 1) * u\noutput y"]]);
		const data = computePlot(parsePlot("axes t 0..8, y\nresponse loop1 y to step r"), scope);
		const l = data.lines[0]!;
		assert.equal(l.name, "loop1.y");
		near(l.y.at(-1)!, 0.75 * (1 - Math.exp(-8)), 1e-3);
		assert.throws(() => computePlot(parsePlot("axes t 0..8, y\nresponse nope y to step r"), scope), /no block diagram with id=nope/);
	});

	it("parse errors carry the line and a template", () => {
		assert.throws(() => parsePlot("curve y = t"), (e: FigureError) => /first line must be "axes"/.test(e.message) && e.line === 1);
		assert.throws(() => parsePlot("axes t 0..10, y\ncurve y = K*t"), /"K" has no value — add "param K/);
		assert.throws(() => computePlot(parsePlot("axes t 0..10, y\ncurve y = 1/(t - 5)")), /not a finite number/);
	});
});

describe("figures in questions", () => {
	const stem = "Se på sløyfen:\n\n```blocks id=loop1\nparam K = 2, T = 4, K_p = 1.5\ninput r\nsum e = r - y\ngain u = K_p * e\ntf y = K/(T*s + 1) * u\noutput y\n```\n\nHva er stasjonærverdien?";

	it("finds fences with their ids and builds the diagram scope", () => {
		assert.deepEqual(figureFences(stem).map((f) => [f.lang, f.id]), [["blocks", "loop1"]]);
		assert.ok(diagramScope([stem]).has("loop1"));
	});

	it("figureProblems: clean figures pass; a broken one is named with its line", () => {
		assert.deepEqual(figureProblems([stem, "```plot\naxes t 0..10, y\nresponse loop1 y to step r\n```"]), []);
		const [p] = figureProblems(["```blocks\ninput r\ngain u = 2 * x\noutput u\n```"]);
		assert.match(p!, /^Figure 1 \(```blocks\) line 2: gain reads no signal of this diagram/);
		assert.match(figureProblems([stem, stem])[0]!, /id=loop1 is used twice/);
	});

	it("labelNumbers reads real option labels", () => {
		assert.deepEqual(labelNumbers("$T_p = \\frac{8}{5}$"), [1.6]);
		assert.deepEqual(labelNumbers("$0{,}64$"), [0.64]);
		assert.deepEqual(labelNumbers("16 %"), [16]);
		near(labelNumbers("$\\zeta=\\frac{3\\sqrt{2}}{4}$, underdempet")[0]!, (3 * Math.SQRT2) / 4, 1e-12);
		assert.deepEqual(labelNumbers("$T = \\frac{1}{2}$, $K = 3$"), [0.5, 3]);
		assert.deepEqual(labelNumbers("Integratoren vokser stort"), []);
	});

	it("judgeFigureCheck verifies the key, or names the computed value and the option it matches", () => {
		const options = [{ label: "$0{,}75$" }, { label: "$1$" }, { label: "$0{,}25$" }];
		const check = { figure: "loop1", quantity: "steady(y)" };
		assert.deepEqual(judgeFigureCheck([stem], options, [0], check), { verified: true, problems: [] });
		const wrong = judgeFigureCheck([stem], options, [1], check);
		assert.equal(wrong.verified, false);
		assert.match(wrong.problems[0]!, /steady\(y\) = 0\.75 .* that value is option "\$0\{,\}75\$"/);
		assert.match(judgeFigureCheck([stem], options, [0], { figure: "nope", quantity: "steady(y)" }).problems[0]!, /no figure in the question has id=nope/);
		assert.match(judgeFigureCheck([stem], options, [0], { figure: "loop1", quantity: "speed(y)" }).problems[0]!, /is not one of/);
		const at = judgeFigureCheck([stem], [{ label: "$0{,}47$" }], [0], { figure: "loop1", quantity: "y(t=1)" });
		assert.equal(at.verified, true, at.problems.join());
	});

	it("figureFacts: the computed response, in sentences", () => {
		const [fact] = figureFacts([stem]);
		assert.match(fact!, /simulated with a unit step on r over 0\.\.20: output y settles at 0\.75, overshoot 0 %/);
	});
});

describe("the agent side", async () => {
	const { FIGURE_GUIDES, figureGuideTool } = await import("../src/agent/tools/figures.ts");
	const { probeQuizTool } = await import("../src/agent/tools.ts");

	it("every example in the figure guide parses, computes and resolves", () => {
		for (const [family, guide] of Object.entries(FIGURE_GUIDES)) {
			const fences = figureFences(guide);
			assert.ok(fences.length >= 1, `${family}: the guide carries an example`);
			assert.deepEqual(figureProblems([guide]), [], `${family}: guide examples must be valid`);
		}
	});

	it("figure_guide returns one family's syntax", async () => {
		const out = (await figureGuideTool.execute("c1", { family: "plot" })) as { content: Array<{ text: string }> };
		assert.match(out.content[0]!.text, /```plot — graphs computed by the app/);
	});

	it("a probe with a broken figure is returned to the author with the line", async () => {
		const input = {
			question: "Hva er y?\n\n```blocks\ninput r\ngain u = 2 * r\n```",
			explanation: "…",
			options: [
				{ label: "1", value: "a" },
				{ label: "2", value: "b" },
			],
			correctAnswer: "a",
		};
		const result = (await probeQuizTool.execute("c1", input as never)) as { content: Array<{ text: string }> };
		assert.match(result.content.map((c) => c.text).join(""), /Figure 1 \(```blocks\) line 2: the diagram needs at least one "output|line \d+: the diagram needs/);
	});
});
