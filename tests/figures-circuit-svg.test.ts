/**
 * The circuit figure's svg must be well-formed XML, not just HTML-tolerable (owner, 2026-11-25): the full-screen view loads it as an
 * <img> data URI, an XML image document, and a duplicate attribute (stroke-width twice on a voltage source's +/− path) made it fail
 * to load: a broken-image icon and the alt text "Figure". The inline figure never showed it (the HTML parser keeps the last one).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// the renderer measures labels in a live document; a fixed size is enough to look at the markup
(globalThis as { document?: unknown }).document = {
	createElement: () => ({ style: {}, isConnected: true, set innerHTML(_v: string) {}, getBoundingClientRect: () => ({ width: 40, height: 20 }) }),
	body: { appendChild() {} },
};

const { parseCircuit } = await import("../src/core/figures/index.ts");
const { renderCircuitSvg } = await import("../components/figures/circuit-svg.ts");

/** Every start tag's repeated attribute names (an XML parser refuses the document at the first). */
function duplicateAttributes(svg: string): string[] {
	const dups: string[] = [];
	for (const m of svg.matchAll(/<[a-zA-Z][^<>]*>/g)) {
		const names = [...m[0].replace(/"[^"]*"/g, '""').matchAll(/\s([\w:-]+)=/g)].map((x) => x[1]!);
		for (const n of new Set(names.filter((x, i) => names.indexOf(x) !== i))) dups.push(`${n} in ${m[0].slice(0, 80)}`);
	}
	return dups;
}

const SOURCES: Record<string, string> = {
	"sources and ground": "V1 a1 0 12V; down\nR1 a1 a 1k; right\nR2 a 0 2k; down\nW a b; right\nI1 b 0 3mA; down\nnodes a",
	"divider with terminals": "V1 a 0 12V; down\nR1 a b 4k; right, v=U_1\nR2 b 0 2k; down, i=I_2\nW b c; right\nP1 c 0; down\nnodes a, b",
	"RC with a switch, an inductor and a led": "V1 a 0 5V; down\nS1 a b closes; right\nR1 b c 1k; right\nC1 c d 1u; down\nL1 d 0 5m; down\nD1 c e; right, led\nW e 0; down\nsim 0..10m",
	"op-amp": "V1 a 0 0.5V; down\nR1 a n 1k; right\nE1 o 0 opamp p n; right\nW p 0; down\nR2 n f 10k; up\nW f g; right\nW g o; down 1.25\nnodes o",
	"transistors": "V1 vcc 0 12V; down 2\nR1 vcc c 2k; right 3\nQ1 c b e npn; down\nR2 e 0 1k; down\nW b x; left\nR3 x 0 10k; down 1.5",
	"mosfet and controlled sources": "V1 vdd 0 5V; down\nR1 vdd d 1k; right\nM1 d g s nmos; down, mirror\nW s 0; down\nG1 o 0 d 0 2m; down\nE2 p 0 d 0 3; down",
};

describe("circuit svg is well-formed XML (the full-screen image document)", () => {
	for (const [name, src] of Object.entries(SOURCES)) {
		it(`no repeated attribute: ${name}`, () => {
			const svg = renderCircuitSvg(parseCircuit(src), 15);
			assert.deepEqual(duplicateAttributes(svg), []);
		});
	}
});
