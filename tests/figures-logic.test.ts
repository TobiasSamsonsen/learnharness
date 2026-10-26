/**
 * Figures phase 3 (owner, 2026-10-26): logic diagrams and timing — gates,
 * flip-flops and latches simulated slot by slot, WaveJSON timing figures
 * linked to them, and the question checks (ADE ch. 9 and 14).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeTiming,
	diagramScope,
	evaluateLogic,
	FigureError,
	figureFacts,
	figureProblems,
	judgeFigureCheck,
	parseLogic,
	parseTiming,
	waveBits,
} from "../src/core/figures/index.ts";

const halfAdder = "input a, b\nxor s = a, b\nand c = a, b\noutput s, c";

/** A linked timing figure's computed bits for one signal. */
function bitsOf(logic: string, timing: object, signal: string) {
	const t = computeTiming(parseTiming(JSON.stringify(timing)), logic);
	return waveBits(t.signals.find((s) => s?.name === signal)!.wave!);
}

describe("logic diagrams", () => {
	it("a half adder evaluates", () => {
		const d = parseLogic(halfAdder);
		const v = evaluateLogic(d, { a: 1, b: 1 });
		assert.equal(v.get("s"), 0);
		assert.equal(v.get("c"), 1);
		assert.equal(evaluateLogic(d, { a: 1, b: 0 }).get("s"), 1);
	});

	it("refuses undefined and unused signals, wrong arity, and unknown lines", () => {
		const err = (src: string, re: RegExp) => assert.throws(() => parseLogic(src), (e: FigureError) => re.test(e.message));
		err("input a\nand y = a, x\noutput y", /signal "x" is never defined/);
		err("input a, b\nand y = a, b\nor z = a, b\noutput y", /"z" is never used/);
		err("input a\nand y = a\noutput y", /and takes two or more inputs/);
		err("input a\nnot y = a, a\noutput y", /not takes one input/);
		err("input a\nmux y = a\noutput y", /unknown statement "mux"/);
		err("input d, clk\ndff q = d clk\noutput q", /dff takes data and clock/);
	});

	it("a stateful diagram is not evaluated as a truth table", () => {
		assert.throws(() => evaluateLogic(parseLogic("input d, clk\ndff q = d @ clk\noutput q"), { d: 1, clk: 1 }), /stores state/);
	});
});

describe("timing, simulated", () => {
	it("a D flip-flop takes its data from the slot before each rising edge", () => {
		const logic = "input d, clk\ndff q = d @ clk\noutput q";
		const q = bitsOf(logic, { logic: "ff", signal: [{ name: "clk", wave: "p......." }, { name: "d", wave: "01100100" }, { name: "q" }] }, "q");
		assert.deepEqual(q, [0, 0, 1, 1, 0, 0, 1, 0]);
	});

	it("an SR latch built from two NOR gates sets, holds and resets", () => {
		const logic = "input s, r\nnor q = r, q_n\nnor q_n = s, q\noutput q";
		const q = bitsOf(logic, { logic: "sr", signal: [{ name: "s", wave: "0100000" }, { name: "r", wave: "0000100" }, { name: "q" }] }, "q");
		assert.deepEqual(q, ["x", 1, 1, 1, 0, 0, 0]);
	});

	it("the sr element starts at its init value; a D latch follows while enabled", () => {
		const sr = bitsOf("input s, r\nsr q = s, r\noutput q", { logic: "x", signal: [{ name: "s", wave: "0100000" }, { name: "r", wave: "0000100" }, { name: "q" }] }, "q");
		assert.deepEqual(sr, [0, 1, 1, 1, 0, 0, 0]);
		const latch = bitsOf("input d, en\ndlatch q = d @ en\noutput q", { logic: "x", signal: [{ name: "en", wave: "0110000" }, { name: "d", wave: "1010110" }, { name: "q" }] }, "q");
		assert.deepEqual(latch, [0, 0, 1, 1, 1, 1, 1]);
	});

	it("a dff clocked by a gate is refused with a clear message", () => {
		assert.throws(
			() => bitsOf("input d, a, b\nand clk = a, b\ndff q = d @ clk\noutput q", { logic: "x", signal: [{ name: "a", wave: "0101" }, { name: "b", wave: "1111" }, { name: "d", wave: "1111" }, { name: "q" }] }, "q"),
			/the clock of q must be an input/,
		);
	});
});

describe("logic in questions", () => {
	const ff = "```logic id=ff\ninput d, clk\ndff q = d @ clk\noutput q\n```";
	const timing = '```timing id=t1\n{"logic": "ff", "signal": [{"name": "clk", "wave": "p......"}, {"name": "d", "wave": "0110100"}, {"name": "q"}]}\n```';

	it("figureCheck reads a slot of a linked timing figure, and an output of a truth table", () => {
		assert.equal(judgeFigureCheck([ff, timing], [{ label: "1" }, { label: "0" }], [0], { figure: "t1", quantity: "q[3]" }).verified, true);
		const wrong = judgeFigureCheck([ff, timing], [{ label: "1" }, { label: "0" }], [1], { figure: "t1", quantity: "q[3]" });
		assert.match(wrong.problems[0]!, /q\[3\] = 1/);
		const ha = "```logic id=ha\n" + halfAdder + "\n```";
		assert.equal(judgeFigureCheck([ha], [{ label: "0" }, { label: "1" }], [1], { figure: "ha", quantity: "c(a=1, b=1)" }).verified, true);
	});

	it("a timing figure without its logic, or missing an input wave, is refused", () => {
		assert.match(figureProblems([timing])[0]!, /no logic diagram with id=ff/);
		const noD = '```timing\n{"logic": "ff", "signal": [{"name": "clk", "wave": "p...."}, {"name": "q"}]}\n```';
		assert.match(figureProblems([ff, noD])[0]!, /give every input of ff a wave \(missing: d\)/);
		assert.match(figureProblems(["```timing\n{not json}\n```"])[0]!, /not valid JSON/);
	});

	it("facts: a truth table, and the simulated waves", () => {
		assert.match(figureFacts(["```logic id=ha\n" + halfAdder + "\n```"]).join("\n"), /a=1 b=1 → s=0 c=1/);
		assert.match(figureFacts([ff, timing]).join("\n"), /q: 0011010/);
		assert.ok(diagramScope([ff]).has("ff"));
	});
});
