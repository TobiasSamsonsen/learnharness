/**
 * A circuit the tutor directed itself (owner, 2026-11-26): when every element line carries a direction the drawing is exactly what it
 * wrote, and the wiring read back off it must be the netlist's. No direction at all falls back to the automatic layout
 * (figures-circuit-auto.test.ts); a netlist with only some directions is refused.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIGURE_GUIDES } from "../src/agent/tools/figures.ts";
import { FigureError, layoutCircuit, layoutDirected, parseCircuit } from "../src/core/figures/index.ts";

// the examples the tutor guide taught before the automatic layout (known-good directed netlists)
const DIRECTED: Record<string, string> = {
	divider: "V1 a 0 12V; down\nR1 a b 4k; right, v=U_1\nR2 b 0 2k; down, i=I_2\nW b c; right\nP1 c 0; down\nnodes a, b",
	norton: "V1 a1 0 12V; down\nR1 a1 a 1k; right\nR2 a 0 2k; down\nW a b; right\nI1 b 0 3mA; down\nnodes a",
	rc: "V1 a 0 5V; down\nS1 a b closes; right\nR1 b c 1k; right\nC1 c 0 1u; down, v=v_C\nsim 0..10m",
	inverting: "V1 a 0 0.5V; down\nR1 a n 1k; right\nE1 o 0 opamp p n; right\nW p 0; down\nR2 n f 10k; up\nW f g; right\nW g o; down 1.25\nnodes o",
	"common emitter": "V1 vcc 0 12V; down 2\nR1 vcc c 2k; right 3\nQ1 c b e npn; down\nR2 e 0 1k; down\nW b x; left\nR3 x 0 10k; down 1.5",
};

describe("a fully directed netlist is drawn as written", () => {
	for (const [name, src] of Object.entries(DIRECTED)) {
		it(name + ": the directed engine's drawing, one placed part per line, wiring verified", () => {
			const c = parseCircuit(src); // lays out and verifies
			const laid = layoutCircuit(c);
			assert.equal(laid.placed.length, c.elements.length, "no wires added by the app");
			assert.deepEqual(laid.placed.map((p) => [p.a, p.b]), layoutDirected(c).placed.map((p) => [p.a, p.b]));
			for (const n of c.shownNodes) assert.ok(laid.nodes.get(n), "a labelled node has a point: " + n);
		});
	}

	it("one ground rail: the source and the + input share a node that a single wire takes to ground", () => {
		const c = parseCircuit(
			"V1 a g 0.5V; down\nR1 a n 1k; right\nE1 o 0 opamp p n; right\nW p q; down 0.5\nW q g; left\nW g 0; down 0.5\nR2 n f 10k; up\nW f h; right\nW h o; down 1.25\nnodes o",
		);
		const laid = layoutCircuit(c);
		assert.equal(laid.placed.filter((p) => !p.el.opamp && (p.el.n1 === "0" || p.el.n2 === "0")).length, 1, "one ground symbol");
	});

	it("the hand-planned op-amp netlist that put the current source on the + input is refused, not drawn", () => {
		assert.throws(
			() => parseCircuit("I1 0 n 2mA; up\nE1 o 0 opamp p n; right\nW p 0; down\nR2 n f 5k; up\nW f g; right\nW g o; down 1.25\nnodes o"),
			(e: unknown) => e instanceof FigureError && /I1 and W are drawn on top of each other/.test(e.message),
		);
	});

	it("a part drawn where it touches another node is refused: the wiring read back must be the netlist's", () => {
		// d lands in the middle of the wire a–b: drawn, it would connect d to a and b
		const src = "V1 a 0 5V; down\nW a b; right 2\nW a e; up\nR3 e c 1k; right\nR2 c d 1k; down\nR4 b 0 1k; down\nR5 d 0 1k; down";
		assert.doesNotThrow(() => parseCircuit(src.replace(/; (right|left|up|down)( [\d.]+)?/g, ""))); // the same topology, placed by the app
		assert.throws(
			() => parseCircuit(src),
			(e: unknown) => e instanceof FigureError && /would not show your netlist: nodes .* are drawn connected/.test(e.message),
		);
	});
});

describe("the tutor guide", () => {
	it("every example in it is a netlist that draws and passes the wiring check", () => {
		const fences = [...FIGURE_GUIDES.circuit.matchAll(/^```circuit id=\S+\n([\s\S]*?)^```/gm)].map((m) => m[1]!);
		assert.ok(fences.length === 6, "the guide carries its examples");
		for (const src of fences) {
			const c = parseCircuit(src);
			assert.equal(layoutCircuit(c).placed.length, c.elements.length, "drawn as written: " + src.split("\n")[0]);
		}
	});
});

describe("a netlist with only some directions", () => {
	it("is refused, naming the lines without one and both ways out", () => {
		assert.throws(
			() => parseCircuit("V1 a 0 5V; down\nR1 a b 1k\nR2 b 0 1k; down"),
			(e: unknown) => e instanceof FigureError && e.line === 2 && /R1 has no direction/.test(e.message) && /every element line/.test(e.message) && /remove every direction/.test(e.message),
		);
		assert.throws(() => parseCircuit("V1 a 0 5V; down\nE1 o 0 opamp 0 a\nR1 a o 1k; right"), /E1 has no direction/);
	});

	it("nodes and sim lines are not element lines", () => {
		assert.doesNotThrow(() => parseCircuit("V1 a 0 5V; down\nR1 a b 1k; right\nR2 b 0 1k; down\nnodes b\nsim 0..1m"));
	});

	it("no direction anywhere falls back to the automatic layout", () => {
		const c = parseCircuit("V1 a 0 5V\nR1 a b 1k\nR2 b 0 1k\nR3 b 0 2k");
		assert.ok(layoutCircuit(c).placed.length > c.elements.length, "the app added wires");
	});
});
