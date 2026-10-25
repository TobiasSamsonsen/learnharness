import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

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

export const FIGURE_GUIDES: Record<"blocks" | "plot", string> = { blocks: BLOCKS_GUIDE, plot: PLOT_GUIDE };

const figureGuideInput = Type.Object({
	family: Type.Union([Type.Literal("blocks"), Type.Literal("plot")], { description: "Which figure family's syntax to return." }),
});

export const figureGuideTool: AgentTool<typeof figureGuideInput> = {
	name: "figure_guide",
	label: "figure_guide",
	description:
		"Returns the full syntax, rules and examples of one figure family (```blocks block diagrams, ```plot graphs). " +
		"Call it before writing your first figure of a family in this session.",
	parameters: figureGuideInput,
	execute: async (_toolCallId, input) => ({
		content: [{ type: "text", text: FIGURE_GUIDES[input.family] }],
		details: { family: input.family },
	}),
};
