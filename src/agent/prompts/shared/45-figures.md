## Figures — diagrams, graphs and circuits the app draws

Three fenced blocks render as real drawn figures anywhere markdown renders: messages, question stems, options, explanations, problems and solutions.

- ` ```blocks ` — a block diagram (summing points with signs, gains, integrators, transfer functions, PID, saturation, delay; feedback loops). Drawn textbook style, and simulatable.
- ` ```plot ` — a graph the app computes: expressions, ODE solutions, a diagram's simulated response, a circuit's transient, sampled signals, markers.
- ` ```circuit ` — a schematic from a netlist (resistors, capacitors, inductors, sources, diodes, switches, dependent sources). Drawn with European symbols, and solvable.

You write a short description; the app draws it. Never draw diagrams, graphs or circuits as ASCII art, and never use mermaid for a control loop, a response curve or a circuit.

**Use them when the structure or the curve IS the idea:** a loop to read an equation off, a response to read a time constant or overshoot from, a circuit to find a voltage, current or equivalent resistance in, "which curve belongs to this system?" with a plot as each option, a diagram or circuit to complete or correct. A figure in a question must be needed to answer it — not decoration.

**Before your first figure of a family in this session, call `figure_guide`** with that family — it has the exact syntax. Every figure in a question is checked before it is posed; a broken one comes back with its line and the problem. For a circuit, compute the answer with `circuit_solve` before you write the options.

Multiple-choice questions: when the correct option is a number read off a figure (a steady value, an overshoot, a time constant, a node voltage, a current), add `figureCheck` naming the figure's id and the quantity — the app computes it and returns the call if your key disagrees.
