# Figures — text-described diagrams the app draws

Fork feature, owner design round 2026-10-26. Questions and lessons could show only text, LaTeX and mermaid, so circuits, control loops and response curves could not be asked about. Figures fix that: the model writes a short description in a fenced block, the app renders a real SVG instantly — anywhere markdown renders (messages, question stems, options, explanations, practice problems).

## Phases

1. **Done** — shared infrastructure, ` ```plot ` and ` ```blocks ` (block diagrams, simulatable). Kyb Intro.
2. **Done** — ` ```circuit `: an lcapy-style netlist (European symbols), drawn from the directions the tutor writes, or placed and routed automatically when it writes none (2026-11-26, see below), solved by modified nodal analysis — DC, equivalent resistance, transients after switches move at t = 0 — behind `figureCheck`, the `circuit_solve` tool and a plot `transient` line. ADE.
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
| Circuits: parse, grid layout of a directed netlist, MNA solver, quantities | `src/core/figures/circuit.ts` |
| Circuits: automatic placement and routing (fallback for a netlist without directions), drawing-vs-netlist checks | `src/core/figures/circuit-auto.ts` |
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
- Circuits: diodes, BJTs (npn/pnp) and MOSFETs (nmos/pmos, enhancement, body tied to source) are drawn, not solved; op-amps are drawn and solved as ideal (V+ = V−). Netlist forms follow SPICE (Q c b e, M d g s) and lcapy (E out ref opamp in+ in−); symbols follow IEC 60617, the op-amp as the textbook triangle. Node 0 is ground and gets a symbol at every connection.
- Circuit layout (owner, 2026-11-26, reverses the always-automatic rule below): the tutor directs the drawing itself again, in textbook form (the guide in `src/agent/tools/figures.ts`: inputs left, output right, upright sources, one ground rail, feedback above the op-amp). `layoutCircuit` reads the directions: EVERY element line directed → the model's layout exactly as written (`layoutDirected`), then `verifyDirected` reads the wiring back off the geometry and refuses a drawing that does not show the netlist (a part landing on another node's wire; names joined by `W` are one node, a node joined to `0` is ground); NO direction anywhere → the automatic layout below, so every circuit written between 2026-11-25 and 2026-11-26 still draws (checked on the 23 circuits in the Tab's 37 chats on 2026-11-26: none refused); SOME directions → refused, naming the lines without one. A refusal reaches the tutor as a tool error (question tools) or one hidden nudge (text-only reply). Why: the autorouter drew a three-part op-amp circuit badly (a wire through a label, ground detours), and drawing the circuit is part of how a learner learns it. Cost: the model can again plan a loop that does not close or put a part on the + input; the checks catch the first kind, and a part on the wrong node is a topology error the app cannot see. Chats from before 2026-11-25 carry directions again and are drawn from them (some may now show a refusal where the autorouter used to draw them).
- Automatic layout (owner, 2026-11-25; now the fallback): the tutor writes the topology only. A hand-planned geometry (directions, lengths, op-amp offsets, wires to steer a loop) was something no model effort made reliable: in a real op-amp lesson the tutor put a current source on the + input. `circuit-auto.ts` now places every part and routes every wire with a seeded annealing search over a quarter-unit grid (op-amp inputs sit a quarter above and below its input side), merges wire elements into node names, gives a grounded op-amp or transistor pin its own short wire to a ground symbol, and emits an ordinary directed netlist (wires as `W` elements on nodes named by grid point) that `layoutDirected` places and checks as before. Same netlist, same picture on every device (the search is seeded from the netlist). `verifyDrawing` reads the wiring back off the geometry (wires join at their ends and where an end lands on another wire; crossings do not) and compares it with the netlist; `layoutCircuit` retries up to four searches and takes the best, so a clean-but-plain drawing beats a refused one. Used only when no line has a direction. Cost: about 150–300 ms for a typical 6–10 part figure on a laptop, cached by netlist.
- Logic: a dff's clock must be a diagram input (no ripple counters yet); it samples its data from the slot before a rising edge. Timing works in whole slots.
- Transients use backward Euler with 4000 steps (≈0.1 % error at τ for a 10τ window).
