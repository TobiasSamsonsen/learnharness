# Figures — text-described diagrams the app draws

Fork feature, owner design round 2026-10-26. Questions and lessons could show only text, LaTeX and mermaid, so circuits, control loops and response curves could not be asked about. Figures fix that: the model writes a short description in a fenced block, the app renders a real SVG instantly — anywhere markdown renders (messages, question stems, options, explanations, practice problems).

## Phases

1. **Done** — shared infrastructure, ` ```plot ` and ` ```blocks ` (block diagrams, simulatable). Kyb Intro.
2. **Done** — ` ```circuit `: an lcapy-style netlist with drawing directions (European symbols), solved by modified nodal analysis — DC, equivalent resistance, transients after switches move at t = 0 — behind `figureCheck`, the `circuit_solve` tool and a plot `transient` line. ADE.
3. **Done** — ` ```logic ` (signal-flow gates, dff/dlatch/sr, cross-coupled gates allowed; simulated slot by slot) and ` ```timing ` (WaveJSON drawn by our own themed renderer, not the WaveDrom library; `"logic": "<id>"` simulates a linked diagram, `"hide": true` leaves a computed row blank to fill in). ADE.

## Decisions (owner)

- Description + renderer, never ASCII art; fenced blocks, not a tool field.
- Every figure in a question is parsed (and computed) **before it is posed**; the author gets the line and the problem. Lesson prose shows the house error card instead.
- Block diagrams: signal flow (each line names its output and inputs), drawn **textbook style**; the line order is the forward path (ELK `cycleBreaking: MODEL_ORDER`), so an edge back to an earlier line is feedback and enters its sum from below.
- A plot may reference a diagram by `id=` in the same question (stem, details, options, explanation) or message. Practice problems scope each field on its own (statement and solution are separate cards).
- `figureCheck` (quiz/probe, never shown) names a figure quantity; the app computes it and refuses the call when the correct option's number disagrees (1 %). Every figure's computed response is also handed to the blind second model as facts.
- The syntax lives in the `figure_guide` tool (on demand); the always-on prompt (`shared/45-figures.md`) only says figures exist and when to use them.

## Where things live

| Concern | File |
|---|---|
| Expressions (Pratt parser, LaTeX, rational functions in s) | `src/core/figures/expr.ts` |
| Line format shared by families | `src/core/figures/lines.ts` |
| Block diagrams: parse, validate, simulate (RK4) | `src/core/figures/blocks.ts` |
| Plots: parse, compute | `src/core/figures/plot.ts` |
| Response metrics | `src/core/figures/metrics.ts` |
| Circuits: parse, grid layout, MNA solver, quantities | `src/core/figures/circuit.ts` |
| Logic and timing: parse, simulate, WaveJSON | `src/core/figures/logic.ts` |
| Question gate, `figureCheck`, label numbers, facts | `src/core/figures/figure-check.ts` |
| The guide and circuit_solve tools | `src/agent/tools/figures.ts` |
| Server key check | `src/server/question-check.ts` |
| Rendering (ELK layout, KaTeX labels, plots) | `components/figures/` |
| Fence dispatch | `components/md-blocks.tsx` `MarkdownCode` |
| Scope (diagram ids) | `components/figures/figure-scope.tsx`, provided by `MessageResponse`, the question dock and the answered card |

## Known limitations

- In integrator-chain diagrams, feedback gains are placed to the right of the forward path rather than underneath it (ELK cannot flip a block's direction).
- Tick labels use a decimal point.
- Circuits: diodes are drawn, not solved; transistors and op-amps are not drawn yet. Node 0 is ground and gets a symbol at every connection; every other node must land on one grid point (loops have to close).
- Logic: a dff's clock must be a diagram input (no ripple counters yet); it samples its data from the slot before a rising edge. Timing works in whole slots.
- Transients use backward Euler with 4000 steps (≈0.1 % error at τ for a 10τ window).
