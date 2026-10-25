/**
 * Figures phase 2 (owner, 2026-10-26): circuits — the netlist, the grid
 * layout from directions, and the MNA solver, pinned against circuits
 * solvable by hand (ADE: Kirchhoff, Thévenin, RC/RL transients).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { circuitQuantity, FigureError, formatSI, layoutCircuit, parseCircuit, parseSI } from "../src/core/figures/index.ts";

const near = (a: number | string, b: number, tol: number) => {
	assert.equal(typeof a, "number", String(a));
	assert.ok(Math.abs((a as number) - b) <= tol, `expected ${b}, got ${a}`);
};

const divider = "V1 a 0 5V; down\nR1 a b 2k; right\nR2 b 0 3k; down";

describe("values", () => {
	it("SI prefixes, m = milli and M/meg = mega", () => {
		assert.equal(parseSI("2k"), 2000);
		assert.equal(parseSI("10uF"), 10e-6);
		near(parseSI("4.7meg")!, 4.7e6, 1e-6);
		assert.equal(parseSI("5m"), 0.005);
		assert.equal(parseSI("2M"), 2e6);
		assert.equal(parseSI("5V"), 5);
		assert.equal(parseSI("2 kΩ"), 2000);
		assert.equal(parseSI("x"), null);
		assert.equal(formatSI(2000, "Ω"), "2 kΩ");
		assert.equal(formatSI(0.0025, "A"), "2.5 mA");
	});
});

describe("netlist and layout", () => {
	it("places nodes on the grid from the directions; ground is never a constraint", () => {
		const { nodes } = layoutCircuit(parseCircuit(divider));
		assert.deepEqual(nodes.get("a"), { x: 0, y: 0 });
		assert.deepEqual(nodes.get("b"), { x: 1, y: 0 });
	});

	it("a loop that does not close is refused with the offending line", () => {
		assert.throws(
			() => parseCircuit("V1 a 0 5V; down\nR1 a b 1k; right\nR2 b c 1k; down\nR3 c a 1k; right"),
			(e: FigureError) => e.line === 4 && /goes right from c to a, but the other lines already put a 1 left and 1 up of c/.test(e.message),
		);
	});

	it("malformed lines name the template", () => {
		assert.throws(() => parseCircuit("X1 a b 1k"), /names start with R, C, L/);
		assert.throws(() => parseCircuit("R1 a b; right"), /needs one value/);
		assert.throws(() => parseCircuit("R1 a b 2q; right"), /not a value/);
		assert.throws(() => parseCircuit("S1 a b; right"), /needs its state/);
		assert.throws(() => parseCircuit("R1 a b 1k; sideways"), /unknown option "sideways"/);
	});
});

describe("solving", () => {
	const c = parseCircuit(divider);

	it("DC: the divider's node voltage, current and power", () => {
		near(circuitQuantity(c, "V(b)"), 3, 1e-6);
		near(circuitQuantity(c, "V(a, b)"), 2, 1e-6);
		near(circuitQuantity(c, "I(R1)"), 1e-3, 1e-9);
		near(circuitQuantity(c, "P(R2)"), 3e-3, 1e-9);
		// the source delivers: current n1 → n2 THROUGH it is negative
		near(circuitQuantity(c, "I(V1)"), -1e-3, 1e-9);
	});

	it("equivalent resistance with the sources zeroed (Thévenin)", () => {
		near(circuitQuantity(c, "R(b, 0)"), 1200, 1e-4);
	});

	it("a current source and a VCVS amplifier", () => {
		near(circuitQuantity(parseCircuit("I1 0 a 2mA; up\nR1 a 0 1k; right"), "V(a)"), 2, 1e-6);
		const amp = parseCircuit("V1 a 0 0.1V; down\nR1 a 0 10k; right\nE1 o 0 a 0 20; down\nR2 o 0 1k; right");
		near(circuitQuantity(amp, "V(o)"), 2, 1e-6);
	});

	it("RC charging after a switch closes: τ = RC, v(τ) = 63 %", () => {
		const rc = parseCircuit("V1 a 0 5V; down\nS1 a b closes; right\nR1 b c 1k; right\nC1 c 0 1u; down\nsim 0..10m");
		near(circuitQuantity(rc, "V(c, t=1m)"), 5 * (1 - Math.exp(-1)), 0.01);
		near(circuitQuantity(rc, "tau(V(c))"), 1e-3, 2e-5);
		near(circuitQuantity(rc, "V(c)"), 5, 1e-5);
	});

	it("RC discharging: the initial value comes from the t < 0 steady state", () => {
		const rc = parseCircuit("V1 a 0 5V; down\nS1 a b opens; right\nR1 b 0 1k; down\nC1 b 0 1u; right\nsim 0..5m");
		near(circuitQuantity(rc, "V(b, t=0)"), 5, 0.01);
		near(circuitQuantity(rc, "V(b, t=1m)"), 5 * Math.exp(-1), 0.01);
	});

	it("RL: the current rises with τ = L/R", () => {
		const rl = parseCircuit("V1 a 0 10V; down\nS1 a b closes; right\nR1 b c 100; right\nL1 c 0 10m; down\nsim 0..1m");
		near(circuitQuantity(rl, "I(L1)"), 0.1, 1e-6);
		near(circuitQuantity(rl, "tau(I(L1))"), 1e-4, 3e-6);
	});

	it("time values need sim; diodes draw but do not solve", () => {
		assert.match(String(circuitQuantity(c, "V(b, t=1m)")), /add a "sim 0\.\.<end>"/);
		assert.match(String(circuitQuantity(parseCircuit("V1 a 0 5V; down\nD1 a b; right\nR1 b 0 1k; down"), "V(b)")), /diode — circuits with diodes are drawn, not solved/);
		assert.match(String(circuitQuantity(c, "Z(b)")), /is not a circuit quantity/);
	});
});

describe("circuits in questions", async () => {
	const { figureProblems, judgeFigureCheck, labelNumbers, figureFacts, computePlot, parsePlot, diagramScope } = await import("../src/core/figures/index.ts");
	const stem = "Finn spenningen over $R_2$:\n\n```circuit id=c1\nV1 a 0 5V; down\nR1 a b 2k; right\nR2 b 0 3k; down\n```";

	it("option labels are read with their unit prefixes", () => {
		assert.deepEqual(labelNumbers("$2{,}5\\ \\text{mA}$"), [0.0025]);
		assert.deepEqual(labelNumbers("$1{,}2\\ \\mathrm{k}\\Omega$"), [1200]);
		assert.deepEqual(labelNumbers("3 V"), [3]);
		near(labelNumbers("10 µF")[0]!, 10e-6, 1e-15);
	});

	it("figureCheck verifies a node voltage, and refuses a wrong key naming the right option", () => {
		const options = [{ label: "$3\\ \\text{V}$" }, { label: "$2\\ \\text{V}$" }];
		assert.deepEqual(judgeFigureCheck([stem], options, [0], { figure: "c1", quantity: "V(b)" }), { verified: true, problems: [] });
		const wrong = judgeFigureCheck([stem], options, [1], { figure: "c1", quantity: "V(b)" });
		assert.match(wrong.problems[0]!, /V\(b\) = 3 from figure c1, but the correct option states 2 — that value is option "\$3/);
		assert.equal(judgeFigureCheck([stem], [{ label: "1 mA" }, { label: "2 mA" }], [0], { figure: "c1", quantity: "I(R1)" }).verified, true);
	});

	it("a circuit with a broken loop is refused before posing; facts carry the DC solution", () => {
		const [p] = figureProblems(["```circuit\nV1 a 0 5V; down\nR1 a b 1k; right\nR2 b c 1k; down\nR3 c a 1k; right\n```"]);
		assert.match(p!, /^Figure 1 \(```circuit\) line 4: R3 goes right from c to a/);
		assert.match(figureFacts([stem]).join("\n"), /V\(b\) = 3 V/);
	});

	it("a plot shows a circuit's transient", () => {
		const rc = "```circuit id=rc\nV1 a 0 5V; down\nS1 a b closes; right\nR1 b c 1k; right\nC1 c 0 1u; down\n```";
		const data = computePlot(parsePlot("axes t 0..0.005, v\ntransient rc V(c)"), diagramScope([rc]));
		near(data.lines[0]!.y.at(-1)!, 5 * (1 - Math.exp(-5)), 0.02);
		assert.equal(data.lines[0]!.name, "rc.V(c)");
	});
});

describe("circuit_solve", async () => {
	const { circuitSolveTool } = await import("../src/agent/tools/figures.ts");
	const run = async (circuit: string, quantities: string[]) =>
		((await circuitSolveTool.execute("c1", { circuit, quantities })) as { content: Array<{ text: string }> }).content[0]!.text;

	it("answers in SI units, one line per quantity", async () => {
		const out = await run(divider, ["V(b)", "I(R1)", "R(b, 0)", "P(R2)"]);
		assert.match(out, /^V\(b\) = 3 V$/m);
		assert.match(out, /^I\(R1\) = 1 mA$/m);
		assert.match(out, /^R\(b, 0\) = 1\.2 kΩ$/m);
		assert.match(out, /^P\(R2\) = 3 mW$/m);
	});

	it("reports a netlist error with its line, and an unknown quantity by name", async () => {
		assert.match(await run("V1 a 0 5V; down\nR1 a b; right", ["V(b)"]), /^line 2: R1 needs one value/);
		assert.match(await run(divider, ["Z(b)"]), /^Z\(b\): "Z\(b\)" is not a circuit quantity/);
	});
});
