/**
 * The automatic layout of a ```circuit (owner, 2026-11-25): the tutor writes the topology, the app places and routes it. The old
 * way (directions the model planned by hand) drew a current source on top of an op-amp's + input and could not be fixed by effort.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layoutCircuit, layoutDirected, parseCircuit } from "../src/core/figures/index.ts";
import { autoDirect, verifyDrawing } from "../src/core/figures/circuit-auto.ts";

const GALLERY: Record<string, string> = {
	// the netlist the tutor wrote in the 2026-11-25 op-amp lesson, directions and all (they are ignored now)
	"lesson I-to-V": "I1 0 n 2mA; up\nE1 o 0 opamp p n; right\nW p 0; down\nR2 n f 5k; up\nW f g; right\nW g o; down 1.25\nnodes o",
	"I-to-V, topology only": "I1 0 n 2mA\nE1 o 0 opamp p n\nW p 0\nR2 n o 5k\nnodes o",
	inverting: "V1 a 0 0.5V\nR1 a n 1k\nE1 o 0 opamp p n\nW p 0\nR2 n o 10k\nnodes o",
	"non-inverting": "V1 a 0 1V\nE1 o 0 opamp a n\nR1 n 0 1k\nR2 n o 9k\nnodes o",
	follower: "V1 a 0 1V\nE1 o 0 opamp a o\nR1 o 0 1k\nnodes o",
	summing: "V1 a 0 1V\nV2 b 0 2V\nR1 a n 1k\nR2 b n 2k\nE1 o 0 opamp p n\nW p 0\nR3 n o 5k\nnodes o",
	integrator: "V1 a 0 1V\nR1 a n 1k\nE1 o 0 opamp p n\nW p 0\nC1 n o 1u\nnodes o",
	"difference amp": "V1 a 0 1V\nV2 b 0 2V\nR1 a n 1k\nR2 b p 1k\nR3 n o 10k\nR4 p 0 10k\nE1 o 0 opamp p n",
	"divider with load": "V1 a 0 12V\nR1 a b 4k\nR2 b 0 2k\nR3 b 0 6k\nnodes b",
	"RC with a switch": "V1 a 0 5V\nS1 a b closes\nR1 b c 1k\nC1 c 0 1u\nsim 0..10m",
	"common emitter": "V1 vcc 0 12V\nR1 vcc c 2k\nQ1 c b e npn\nR2 e 0 1k\nR3 vcc b 20k\nR4 b 0 5k",
	Thevenin: "V1 a 0 12V\nR1 a b 4k\nR2 b 0 2k\nP1 b 0\nnodes a, b",
	bridge: "V1 a 0 10V\nR1 a b 1k\nR2 a c 2k\nR3 b 0 3k\nR4 c 0 4k\nR5 b c 5k",
	"two RC sections": "V1 a 0 5V\nR1 a b 1k\nC1 b 0 1u\nR2 b c 1k\nC2 c 0 1u",
	"common source": "V1 vdd 0 5V\nR1 vdd d 1k\nM1 d g 0 nmos\nV2 g 0 2V",
	RLC: "V1 a 0 5V\nR1 a b 100\nL1 b c 10m\nC1 c 0 1u",
	// the course's own op-amp figures (TTT4203 ERT 15 and ERT 25)
	derivator: "V1 x 0 1V\nC1 x z 1u\nR1 z y 10k\nE1 y 0 opamp 0 z\nnodes z, y",
	integrator2: "V1 x 0 1V\nR1 x z 10k\nC1 z y 1u\nE1 y 0 opamp 0 z\nnodes z, y",
	"non-inverting (ERT 15 fig. 6)": "V1 vi 0 1V\nE1 o 0 opamp vi n\nR1 n 0 1k\nR2 n o 2k\nnodes n, o",
	"constant current source (ERT 25 fig. 3)": "V1 a 0 5V\nR1 a p 10k\nR2 p 0 10k\nE1 o 0 opamp p n\nRL o n 1k\nR3 n 0 10k\nnodes n",
};

describe("the automatic layout draws any topology", () => {
	for (const [name, src] of Object.entries(GALLERY)) {
		it(name + ": no overlaps, and the drawing's wiring is the netlist's", () => {
			const c = parseCircuit(src); // lays out (and so checks) the drawing
			const laid = layoutCircuit(c);
			assert.ok(laid.placed.length >= c.elements.filter((e) => e.kind !== "W").length);
			let clean = false;
			for (let attempt = 0; attempt < 4 && !clean; attempt++) {
				const auto = autoDirect(c, attempt);
				clean = auto.hard === 0 && verifyDrawing(auto, layoutDirected(auto.circuit).placed) === null;
			}
			assert.ok(clean, "some attempt is clean");
			for (const n of c.shownNodes) assert.ok(laid.nodes.get(n), "a labelled node has a point: " + n);
		});
	}

	it("is deterministic: the same netlist is drawn the same way every time", () => {
		const a = autoDirect(parseCircuit(GALLERY.bridge!), 0).circuit.elements.map((e) => [e.name, e.n1, e.n2, e.dir, e.len].join(" "));
		const b = autoDirect(parseCircuit(GALLERY.bridge! + "\n"), 0).circuit.elements.map((e) => [e.name, e.n1, e.n2, e.dir, e.len].join(" "));
		assert.deepEqual(a, b);
	});

	it("directions in the netlist are ignored: the lesson's hand-planned netlist (which put the source on the + input) now draws cleanly", () => {
		const c = parseCircuit(GALLERY["lesson I-to-V"]!);
		const auto = autoDirect(c, 0);
		assert.equal(auto.hard, 0);
		assert.equal(verifyDrawing(auto, layoutDirected(auto.circuit).placed), null);
	});

	it("the checker catches a drawing that does not match the netlist", () => {
		const c = parseCircuit(GALLERY["divider with load"]!);
		const auto = autoDirect(c, 0);
		const laid = layoutDirected(auto.circuit);
		assert.equal(verifyDrawing(auto, laid.placed), null);
		// pull every wire off its far end: nothing is connected any more
		const cut = laid.placed.map((p) => (p.el.kind === "W" ? { ...p, b: { x: p.a.x + 7, y: p.a.y + 7 } } : p));
		assert.match(String(verifyDrawing(auto, cut)), /drawn as two separate pieces|drawn connected/);
	});

	it("textbook conventions: one ground symbol, sources and grounded parts upright", () => {
		for (const src of [GALLERY.inverting!, GALLERY.integrator!, GALLERY["divider with load"]!]) {
			const laid = layoutCircuit(parseCircuit(src));
			const groundEnds = laid.placed.filter((p) => !p.el.opamp && (p.el.n1 === "0" || p.el.n2 === "0")).length;
			assert.equal(groundEnds, 1, "one ground symbol for the whole circuit");
			for (const p of laid.placed) {
				if (p.el.kind === "V" || p.el.kind === "I") assert.equal(p.a.x, p.b.x, p.el.name + " is vertical");
			}
		}
	});

	it("a circuit that cannot be drawn cleanly is refused in the tutor's terms, never drawn wrong", () => {
		// shorted and self-referential parts: the kind of netlist no lesson needs
		for (const src of ["V1 a 0 5V\nQ1 a c c npn\nR1 a d 1k\nL2 0 d 1m\nV4 b 0 3V\nV5 a 0 3V", "V1 a 0 5V\nE1 a 0 opamp a a\nR1 a b 1k"]) {
			try {
				const laid = layoutCircuit(parseCircuit(src));
				assert.ok(laid.placed.length > 0); // drawn: then it was verified
			} catch (e) {
				assert.match(String(e), /could not be drawn cleanly — simplify it/);
				assert.doesNotMatch(String(e), /_\d+_\d+/, "no internal node names reach the tutor");
			}
		}
	});

	it("a dozen parts lay out in well under two seconds", () => {
		const lines = ["V1 n0 0 5V"];
		for (let i = 0; i < 5; i++) lines.push(`R${i + 1} n${i} n${i + 1} 1k`, `C${i + 1} n${i + 1} 0 1u`);
		const t0 = Date.now();
		parseCircuit(lines.join("\n"));
		assert.ok(Date.now() - t0 < 2000);
	});
});
