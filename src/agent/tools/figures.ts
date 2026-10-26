import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { circuitQuantity, FigureError, formatSI, parseCircuit } from "../../core/figures/index.ts";

/**
 * figure_guide (figures phase 1, owner 2026-10-26): the full syntax of
 * one figure family, on demand — the always-on prompt (shared/
 * 45-figures.md) only says figures exist and when to use them. The text
 * lives here, not in prompt files, so the desktop build's file trace can
 * never drop it. Read-only; every agent that writes questions holds it.
 */

const FENCE = "```";

const BLOCKS_GUIDE = `# ${FENCE}blocks — block diagrams (drawn textbook style; simulatable)

One statement per line. Each block names its OUTPUT signal, then what it reads. \`#\` starts a comment; a trailing "…" is the block's label, shown in the box instead of its expression (LaTeX allowed: "$K_p$", "Prosess").

| Line | Meaning |
|---|---|
| \`param K = 2, T = 1, K_p = 1.5\` | Numeric parameters (a value may use earlier ones). Without values the diagram still draws, but cannot simulate. |
| \`input r\` / \`input d "forstyrrelse"\` | An external signal (reference, disturbance, noise). |
| \`sum e = r - y\` | Summing point; a sign per input, any number of inputs (\`sum v = u + d - n\`). |
| \`gain u = K_p * e\` | Gain: \`<factor> * <signal>\` (also \`e / 2\`, \`-e\`). |
| \`int x = e\` | Integrator 1/s. Options after \`;\`: \`limit [-1, 1]\` (clamping anti-windup), \`init 0.5\`. |
| \`deriv v = e\` | Derivative s. |
| \`tf y = K/(T*s + 1) * u\` | Transfer function × signal — the signal LAST. Proper rational in s. |
| \`pid u = e; K_p = 2, T_i = 1, T_d = 0.25\` | PID, standard form u = K_p(e + 1/T_i ∫e + T_d ė); or \`K_p, K_i, K_d\` (parallel). Omit a term to drop it. |
| \`sat us = u in [-1, 1]\` | Saturation (metning). |
| \`deadzone w = u in [-0.1, 0.1]\` | Dead zone (dødsone). |
| \`delay z = y; 0.5\` | Time delay of 0.5. |
| \`output y\` | A signal shown leaving the diagram (at least one). |
| \`sim 0..20\` | Simulation time (default 0..20). |

Rules: every signal is defined exactly once and used; names are letters/digits/_ (\`K_p\` renders as $K_p$, Greek names like \`zeta\`, \`omega_0\` as symbols); \`s\` is reserved; a feedback loop must pass an \`int\`, a strictly proper \`tf\` or a \`delay\` (no algebraic loops). Expressions: + - * / ^, explicit *, sin cos tan exp ln log10 sqrt abs sign step min max, pi, e.

Give the fence an id when a plot or a figureCheck refers to it: ${FENCE}blocks id=loop1

Example — P control of a first-order process, with a disturbance:

${FENCE}blocks id=loop1
param K = 2, T = 4, K_p = 1.5
input r "referanse"
input d "forstyrrelse"
sum e = r - y
gain u = K_p * e
sum v = u + d
tf y = K/(T*s + 1) * v
output y
${FENCE}

Example — a mass-spring-damper built from integrators (Simulink style), position x:

${FENCE}blocks id=msd
param m = 1, d = 0.4, k = 4
input F
sum a = F - fd - fk
gain acc = 1/m * a
int v = acc
int x = v
gain fd = d * v
gain fk = k * x
output x
sim 0..30
${FENCE}

Simulation facts: the response of every output to a unit step on the first input is computed and handed to the answer check. In a quiz, \`figureCheck: {figure: "loop1", quantity: "steady(y)"}\` makes the app verify the correct option's number (steady, overshoot %, peak, peaktime, settling (2 %), rise (10–90 %), tau (63 %), or y(t=2); \`input: "step d"\` to excite another input).`;

const PLOT_GUIDE = `# ${FENCE}plot — graphs computed by the app

The first line is \`axes\`; then one line per curve. A trailing "…" is the curve's legend label (LaTeX allowed).

| Line | Meaning |
|---|---|
| \`axes t 0..10, y\` | x name and range, y name. Optional y range: \`axes t 0..10, y -0.2..1.5\`. A trailing "y(t)" labels the y axis. |
| \`xlabel "t [s]"\` | The x axis label (default: the x name). |
| \`param K = 2, T = 4\` | Numeric parameters for the expressions. |
| \`curve y = 1 - exp(-t/2) "T = 2"\` | An expression in the x variable. Name it — checks refer to curves by name. |
| \`ode x' = -x/T + K/T*u, x(0) = 0, u = step(t) "K = 2"\` | An ODE solved from 0 (RK4). Several states: \`ode x' = v, v' = -k*x - d*v, x(0) = 1\`; the FIRST state is drawn. Helper definitions like \`u = step(t)\` are allowed; a missing x(0) is 0. |
| \`response loop1 y to step r "closed loop"\` | The simulated response of signal y of the ${FENCE}blocks id=loop1 diagram in the same question/message (a practice problem's statement and solution are separate — repeat the diagram where needed). Excitations: \`step r\`, \`step(2) r\`, \`ramp r\`, \`impulse r\`, \`sine(0.5) r\` (Hz). Its curve name is \`loop1.y\`. |
| \`transient c1 V(c) "$v_C(t)$"\` | The transient of a ${FENCE}circuit id=c1 in the same question/message after its switches move at t = 0: V(node), V(a,b) or I(element). Its curve name is \`c1.V(c)\`. |
| \`samples sin(2*pi*3*t), fs = 8 "sampled"\` | Stems at t = k/fs over the faint continuous signal (sampling, aliasing). |
| \`mark t = 2 "T"\` / \`mark y = 0.63\` / \`mark point (2, 0.63) "63 %"\` | Dashed markers and points. |

Expressions: + - * / ^, explicit *, sin cos tan exp ln log10 sqrt abs sign step min max, pi, e; every other name must be the x variable, a param or an ode state.

Example — two first-order responses and the 63 % mark:

${FENCE}plot
axes t 0..10, y "y(t)"
curve y1 = 2*(1 - exp(-t/1)) "T = 1"
curve y2 = 2*(1 - exp(-t/3)) "T = 3"
mark y = 0.63*2 "63 %"
${FENCE}

Example — diagrams as answer options: put the diagram in the stem (id=loop1) and give each option its own plot; the correct option is \`response loop1 y to step r\`, the distractors are curves a specific wrong model would predict (e.g. no steady-state error, the open-loop time constant). Keep each option plot small: one curve, the same axes.

In a quiz, \`figureCheck: {figure: "<plot id>", quantity: "tau(y2)"}\` verifies a number read off a named curve (give the plot fence an id: ${FENCE}plot id=p1).`;

const CIRCUIT_GUIDE = `# ${FENCE}circuit — schematics (IEC symbols; solvable without diodes and transistors)

A netlist: one element per line, \`<name> <node> <node> [value]; <direction> [length], [options]\`. The element is drawn FROM its first node TO its second in the given direction (right, left, up, down; length in grid units, default 1). Node \`0\` is ground: every connection to it gets its own ground symbol, so a loop never has to close through ground — all other nodes must land consistently (a loop that does not close is refused with its line). A trailing "…" is the element's label (LaTeX allowed), drawn instead of its name and value.

| Element | Line | Notes |
|---|---|---|
| Resistor | \`R1 a b 2k; right\` | Values take SI prefixes: p n u (µ) m k M (meg) G — m is milli, M is mega. Units may follow: 2kΩ, 10uF, 5V. |
| Capacitor | \`C1 b 0 10u; down\` | Option \`ic=2V\`: its voltage (first node − second) just before t = 0. |
| Inductor | \`L1 b c 5m; right\` | Option \`ic=…\`: its current (first → second) just before t = 0. |
| Voltage source | \`V1 a 0 5V; down\` | The FIRST node is + : V(a) − V(0) = 5 V. |
| Current source | \`I1 0 a 2mA; up\` | Drives the current from the first node to the second through the source — out of the second node. |
| Diode / LED | \`D1 a b; right\` / \`D1 a b; right, led\` | Anode first. Drawn, not solved. |
| Switch | \`S1 a b closes; right\` | open, closed, opens (at t = 0) or closes (at t = 0). |
| Wire | \`W a b; up\` | Name optional (\`W\`), no value. |
| Terminal pair | \`P1 a b; down\` | Open terminals (klemmer) between a and b, e.g. for Thévenin. |
| VCVS / VCCS | \`E1 o 0 a 0 20; down\` / \`G1 o 0 a 0 2m; down\` | Output nodes, then the controlling pair, then the gain: V(o) = 20·V(a, 0), or a current 2 mS·V(a, 0). |
| Op-amp (ideal) | \`E1 o 0 opamp p n; right\` | lcapy's form: output, reference (0, not drawn), \`opamp\`, + input, − input. The direction runs from the inputs to the output. Solved as ideal (V+ = V−, no input current). |
| BJT | \`Q1 c b e npn; down\` | SPICE order: collector, base, emitter, then npn or pnp. The direction runs collector → emitter. Drawn, not solved. |
| MOSFET | \`M1 d g s nmos; down\` | SPICE order: drain, gate, source, then nmos or pmos (enhancement; body tied to the source). The direction runs drain → source. Drawn, not solved. |

**Where the extra terminals land** (grid units; plan the wires to them): a transistor's base/gate sits 0.5 beside the MIDDLE of its collector–emitter (drain–source) axis — on the left of a vertical transistor, below a horizontal one (option \`mirror\`: the other side). An op-amp's inputs sit 0.25 on either side of its input side — − on top of a horizontal op-amp, on the left of a vertical one (\`mirror\` puts + there) — and the output is \`len\` (default 1) further along the direction, level with the middle: 0.25 below the − input. So feedback from the − input to the output of a rightward op-amp is \`R2 n f 10k; up\`, \`W f g; right\`, \`W g o; down 1.25\`.

Options after the direction: \`v=U_R\` (a voltage label across it, + at the first node), \`i=I_1\` (a current arrow, first → second node), \`mirror\` (transistors, op-amps). Extra lines: \`nodes a, b\` labels those nodes in the drawing; \`sim 0..5m\` sets the transient time (seconds) for values in time.

Give the fence an id when a plot or a figureCheck refers to it: ${FENCE}circuit id=c1

Example — a voltage divider with the output terminals marked:

${FENCE}circuit id=div
V1 a 0 12V; down
R1 a b 4k; right, v=U_1
R2 b 0 2k; down, i=I_2
W b c; right
P1 c 0; down
nodes a, b
${FENCE}

Example — an RC circuit charged when the switch closes:

${FENCE}circuit id=rc
V1 a 0 5V; down
S1 a b closes; right
R1 b c 1k; right
C1 c 0 1u; down, v=v_C
sim 0..10m
${FENCE}

Example — an inverting amplifier (gain −R2/R1):

${FENCE}circuit id=inv
V1 a 0 0.5V; down
R1 a n 1k; right
E1 o 0 opamp p n; right
W p 0; down
R2 n f 10k; up
W f g; right
W g o; down 1.25
nodes o
${FENCE}

Example — a common-emitter stage (drawn only):

${FENCE}circuit id=ce
V1 vcc 0 12V; down 2
R1 vcc c 2k; right 3
Q1 c b e npn; down
R2 e 0 1k; down
W b x; left
R3 x 0 10k; down 1.5
${FENCE}

Solving: \`circuit_solve\` computes quantities while you author; \`figureCheck\` checks a key: V(b), V(a,b), I(R1), P(R1), R(a,b) (sources zeroed — Thévenin), V(c, t=1m), I(C1, t=2m), tau(V(c)), steady(…), rise(…), settling(…). Currents run first node → second THROUGH the element (a source delivering power has a negative current). DC values use the switches' t ≥ 0 state; transients start from the t < 0 steady state. Give a transient at least ~7τ of sim time.`;

const LOGIC_GUIDE = `# ${FENCE}logic — gates and flip-flops (simulatable)

Signal flow, like block diagrams: each line names its output, then its inputs. Gates are drawn with the distinctive (ANSI) shapes. A trailing "…" labels an input.

| Line | Meaning |
|---|---|
| \`input a, b, clk\` | External signals. |
| \`and y = a, b\` | and, or, nand, nor, xor, xnor take two or more inputs; \`not y = a\`, \`buf y = a\` one. |
| \`dff q = d @ clk\` | D flip-flop on the rising edge of clk (clk must be an input). \`dff q, q_n = d @ clk\` adds the inverted output. Option \`; init 1\` (default 0). |
| \`dlatch q = d @ en\` | D latch: follows d while en = 1, holds otherwise. |
| \`sr q = s, r\` | SR latch: s sets, r resets, both 1 is undefined (x). |
| \`output y\` | A signal leaving the diagram (at least one). |

Gates may feed back (an SR latch from two cross-coupled NOR gates simulates correctly). A combinational diagram answers \`figureCheck: {figure: "ha", quantity: "c(a=1, b=1)"}\` and its truth table is computed for the answer check; a stateful one is asked about with a ${FENCE}timing figure.

Example — a half adder:

${FENCE}logic id=ha
input a, b
xor s = a, b
and c = a, b
output s, c
${FENCE}

Example — an SR latch from NOR gates:

${FENCE}logic id=sr
input s, r
nor q = r, q_n
nor q_n = s, q
output q
${FENCE}`;

const TIMING_GUIDE = `# ${FENCE}timing — timing diagrams (WaveJSON)

WaveDrom's WaveJSON: \`{"signal": [{"name": "clk", "wave": "p......"}, …]}\` — one character per time slot. Waves: \`0\` \`1\` low/high, \`x\` unknown, \`z\` high impedance, \`p\`/\`n\` a clock (rising/falling edge at each slot's start; \`P\`/\`N\` with an arrow), \`=\` or \`2\`–\`9\` a data value labelled from \`"data": ["A", "B"]\`, \`.\` continues the previous slot, \`|\` marks a gap. \`{}\` is an empty row; \`"head": {"tick": 0}\` numbers the slots.

**Linked to a logic diagram** — \`"logic": "<id>"\` simulates the ${FENCE}logic id=… in the same question/message: signals WITH a wave drive its inputs (every input needs one), signals WITHOUT a wave are computed from it (drawn in the accent colour). A dff takes its data from the slot BEFORE a rising clock edge. Add \`"hide": true\` to a computed signal to draw it as a blank row to fill in — it is still computed for the check, so the question can ask for it and the explanation can show the same figure without hide.

Example — a D flip-flop, Q to be found:

${FENCE}logic id=ff
input d, clk
dff q = d @ clk
output q
${FENCE}

${FENCE}timing id=t1
{"logic": "ff", "head": {"tick": 0}, "signal": [
  {"name": "clk", "wave": "p......."},
  {"name": "d", "wave": "01100100"},
  {"name": "q", "hide": true}
]}
${FENCE}

A key read off the timing: \`figureCheck: {figure: "t1", quantity: "q[3]"}\` — signal q in slot 3 (slots count from 0).`;

export const FIGURE_GUIDES: Record<"blocks" | "plot" | "circuit" | "logic" | "timing", string> = {
	blocks: BLOCKS_GUIDE,
	plot: PLOT_GUIDE,
	circuit: CIRCUIT_GUIDE,
	logic: LOGIC_GUIDE,
	timing: TIMING_GUIDE,
};

const figureGuideInput = Type.Object({
	family: Type.Union([Type.Literal("blocks"), Type.Literal("plot"), Type.Literal("circuit"), Type.Literal("logic"), Type.Literal("timing")], {
		description: "Which figure family's syntax to return.",
	}),
});

export const figureGuideTool: AgentTool<typeof figureGuideInput> = {
	name: "figure_guide",
	label: "figure_guide",
	description:
		"Returns the full syntax, rules and examples of one figure family (```blocks block diagrams, ```plot graphs, ```circuit schematics, " +
		"```logic gates and flip-flops, ```timing timing diagrams). " +
		"Call it before writing your first figure of a family in this session.",
	parameters: figureGuideInput,
	execute: async (_toolCallId, input) => ({
		content: [{ type: "text", text: FIGURE_GUIDES[input.family] }],
		details: { family: input.family },
	}),
};

const circuitSolveInput = Type.Object({
	circuit: Type.String({ description: "The netlist — the body of a ```circuit fence, without the fence." }),
	quantities: Type.Array(Type.String(), {
		minItems: 1,
		description: "What to compute: V(b), V(a,b), I(R1), P(R1), R(a,b), V(c, t=1m), I(C1, t=2m), tau(V(c)), steady(I(L1)), …",
	}),
});

/** The unit a circuit quantity is measured in. */
function quantityUnit(q: string): string {
	const head = q.trim().split("(")[0]!;
	if (head === "overshoot") return "%";
	if (["tau", "rise", "settling", "peaktime"].includes(head)) return "s";
	const inner = ["steady", "peak"].includes(head) ? q.trim().slice(head.length + 1, 2 + head.length) : head;
	return inner === "V" ? "V" : inner === "I" ? "A" : inner === "P" ? "W" : inner === "R" ? "Ω" : "";
}

/**
 * circuit_solve (figures phase 2, owner 2026-10-26): solve while authoring
 * — "solve it before you write a single option" for circuits. The same
 * solver checks figureCheck keys before a question is posed.
 */
export const circuitSolveTool: AgentTool<typeof circuitSolveInput> = {
	name: "circuit_solve",
	label: "circuit_solve",
	description:
		"Solve a ```circuit netlist: DC node voltages, element currents and powers, equivalent resistance, and transient values after " +
		"its switches move at t = 0. Use it to compute a question's answer before you write the options.",
	parameters: circuitSolveInput,
	execute: async (_toolCallId, input) => {
		let text: string;
		try {
			const c = parseCircuit(input.circuit);
			text = input.quantities
				.map((q) => {
					const v = circuitQuantity(c, q);
					const unit = quantityUnit(q);
					return typeof v === "string" ? `${q}: ${v}` : `${q} = ${unit === "%" ? `${Number(v.toPrecision(4))} %` : formatSI(v, unit)}`;
				})
				.join("\n");
		} catch (err) {
			text = err instanceof FigureError ? `line ${err.line}: ${err.message}` : err instanceof Error ? err.message : String(err);
		}
		return { content: [{ type: "text", text }], details: { quantities: input.quantities } };
	},
};
