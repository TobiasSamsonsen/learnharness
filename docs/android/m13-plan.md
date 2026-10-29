# M13 plan (DRAFT): sketch mode v2, tablet readiness (Galaxy Tab S10+), PC polish

Status: **approved by the owner 2026-10-29; M13a to M13d and M13f built, M13e partly (see STATUS.md for what is verified and what is not); the later owner decisions are listed under "Deviations" in STATUS.md.** Written by Claude on 2026-10-29 from three read-only audits (Android state, sketch mode, responsive layout) and one measured experiment (below). Per AGENTS.md "No guessing", every design choice here is either an owner decision (table) or listed under "Proposed defaults to confirm".

Goal (owner): improve the app on Android and PC, prepare it for the Samsung Galaxy Tab S10+, improve sketch mode.

## Owner decisions (2026-10-29)

| # | Decision |
|---|---|
| Q1 | Sketch scope: **colour + pen width, zoom + pan, grid/ruled background, partial (pixel) eraser + undoable Clear, infinite canvas** |
| Q2 | Tablet scope: **both** layout work (800 and 1280 CSS px) and S Pen details (hover cursor, barrel button) |
| Q3 | Infinite canvas, what the model sees: **find the tile size and downsampling limits by measuring**, so no realistic question cannot be answered. Render rule: **glyph-adaptive floor** (scale so glyphs are at least ~16 px in the final image; tile the ink bounding box in 2D, tiles <= 2000 px, <= 6 tiles; refuse only a sketch too big even at the floor, with a clear message) |
| Q4 | Palette: **5 colours, 3 widths (thin/medium/thick = 2/4/8 px); the new-ink bracket is recoloured** to a colour outside the palette (proposed magenta `#d946ef`) |
| Q5 | Background: grid/ruled is a **UI-only** drawing aid; the model's image stays plain white |
| Q6 | Partial eraser works on **already-sent (kept) ink** too, to fix small mistakes. The model's margin bracket covers **new and edited rows**: a per-stroke new/edited flag replaces the `index >= newFrom` rule |
| Q7 | Enter on a tablet with a keyboard: **detect a hardware keyboard**; Enter then sends like on PC and the "Enter submits" hint shows |
| Q8 | Test device: **Pixel 7 Pro over adb, no tablet**. Tab S10+ specifics (S Pen hover/button, DeX, rotation on the tablet) are code-reviewed only and recorded as **unverified** in STATUS.md |

## Measured: how small can writing get? (experiment, 2026-10-29)

Real strokes (`data/sketches/.../sk_4ed04c68d5ad40f1`, a 2x2 matrix product, digits ~40 px high at 1:1) rendered through `planSketch` and shrunk to seven widths; `claude-sonnet-5-5` (high-resolution tier) transcribed each through `claude -p`. One run per size, so indicative, not statistical.

| Digit height in the final image | Result |
|---|---|
| 40, 28, 20 px | all lines correct; the odd `-5` flagged as unclear, not misread |
| 14 px | all lines correct |
| 10 px | one digit `[?]`, rest correct |
| 7 px | `-1` read as `1`, `-5` as `[?]5` |
| 5 px | mostly illegible |

Provider limits (Claude vision docs, fetched 2026-10-29): models 4.7 and later take up to 2,576 px long edge and 4,784 visual tokens (28x28 px per token) before any resize; older models 1,568 px and 1,568 tokens. Above 20 images in one request every image must be <= 2000 px per side (why `SKETCH_MAX_EDGE` is 2000). A 2000x2000 tile is ~5.2k tokens, so it is shrunk very slightly to ~1920 on the high tier; 6 tiles ~ 30k tokens.

Consequence: tile size only matters through the scale factor. A **floor of ~16 px glyph height** is safe, ~20 px comfortable. Writing 40 px tall can then be shrunk to 0.4x; six 2000 px tiles cover ~15000 x 10000 canvas px. OpenAI limits are from docs only, not measured (owner chose Claude only).

Open measurement questions for M13a (small, cheap): repeat at 3 runs per size for the 14/10 px band; one test with a **multi-tile** sketch (ink spread over 2 x 3 tiles) to check the model keeps track across tiles; one with coloured ink (red/green on white) at the floor.

## Milestones

Each milestone ends with typecheck + lint + the relevant tests, one commit, and a STATUS.md entry. Before any code: read the Next.js docs under `node_modules/next/dist/docs/` for anything touching routes or `app/` (AGENTS.md).

### M13a: render plan for the infinite canvas (core, no UI)
- `planSketch` (src/core/sketch.ts): estimate glyph size from strokes (median stroke bbox height of recent ink), pick the scale (floor 16 px glyph, never above the existing 2x upscale rule), 2D-tile the ink bounding box with tiles <= `SKETCH_MAX_EDGE`, cut at blank rows/columns (generalise `bandCut`), <= `SKETCH_MAX_PAGES`; refuse with a specific message when even the floor does not fit.
- Per-stroke `fresh` flag (new or edited) replaces `newFrom`; the bracket (recoloured) spans fresh rows per tile. Wire change in `contracts/sketch.ts`; old `newFrom` payloads still accepted (mapped to the flag).
- Negative and large coordinates: audit `ink-memory.ts`, the canvas, validation (accepts |n| <= 1e6 already).
- Tests: extend `tests/` sketch plan tests (2D tiling, floor, refusal, flag bracket, negative origin); a golden check that the experiment sketch still plans to one page at 1:1.

### M13b: sketch data model and tools (web canvas)
- Strokes carry `size` and `color` from the toolbar (schema already accepts both); toolbar: 5 colours, 3 widths.
- Partial eraser: splits a stroke at the erased span into pieces (in place, flagged fresh), adjustable radius; whole-stroke erase stays as an option. Undo records erase as an operation that restores the original stroke.
- Clear becomes an undoable operation.
- Fix known rough edges found in the audit: `penSeen` resets on reopen; undo after reload removes only the newest stroke; localStorage write fails silently.

### M13c: infinite canvas, zoom and pan (web, then native ink)
- Canvas in world coordinates with a view transform (zoom + pan); no 12000 px cap; wheel/ctrl+wheel and pinch to zoom, two-finger/middle-button/space-drag to pan; pen never pans.
- World unit is a CSS pixel at zoom 1. Glyph-adaptive scale (M13a) makes writing size at zoom irrelevant to the model.
- Android: `InkLayer`/`InkWire` take the view transform (the `pan` line already exists), native strokes carry size and colour (today fixed 4 / none), eraser uses the shared hit test.
- Native vs server look differs today (androidx `pressurePen` vs perfect-freehand): record it in STATUS.md; do not try to unify in this milestone.

### M13d: backgrounds
- None / grid / ruled / dot options, drawn on the canvas only (follows the view transform), kept out of strokes and out of the model image. Remembered per device.

### M13e: tablet layout and S Pen
- Chrome emulation at 800x1280 and 1280x800: audit the chat, dock, sidebar (inline >= 1024 px, drawer below), settings, sketch toolbar; cap dock height on portrait; sketch toolbar placement for a 12.4" screen.
- Hardware-keyboard detection for Enter (Q7); show the hint.
- Touch targets: raise the `.lh-touch` 40 px floor toward 44-48 px where it matters; hover-only `title=` tooltips get the existing `Hint` long-press path.
- S Pen: hover cursor/brush preview on the web canvas (pointer events with `pointerType: pen`), barrel-button as eraser (already wired on the web side and in `InkLayer`), `FLAG_CANCELED` handling for palm touches; Kotlin hover via `onHoverEvent` for the native layer.
- Manifest: `resizeableActivity` explicitly true, `uses-feature` entries for stylus/touch marked not required, window-size awareness (androidx.window) only if the emulation audit shows a need.
- Everything here that needs the real tablet is listed as unverified.

### M13f: PC
- Mouse: right-click/middle-button pan, wheel zoom, keyboard shortcuts for colour/width/eraser/undo in sketch; Electron-specific audit only for regressions.

## Proposed defaults to confirm (approving the plan approves these)

1. Zoom range 0.1x to 8x, wheel zoom centred on the pointer, double-tap/double-click-with-modifier resets to 1x.
2. Palette: black `#111111`, red `#dc2626`, green `#16a34a`, orange `#ea580c`, blue `#2563eb`; bracket `#d946ef`.
3. Eraser radius presets 10 / 20 / 40 px (screen), world-scaled with zoom.
4. Grid spacing 32 px world; ruled spacing 40 px world.
5. Per-stroke fresh flag name: `fresh`.

## Risks and notes
- Wire and prompt change (bracket colour/semantics): `src/agent/prompts/shared/18-sketches.md` must be updated to describe the recoloured, edit-aware bracket; the prompt change is the largest behavioural risk and needs a read_sketch regression check on the Pixel.
- Partial erase on kept ink changes what "kept page" means for `resolveSketchRef` and `strokes.json`; the sketch-gate (`src/core/sketch-gate.ts`) was not read yet and must be before M13b.
- No tablet, no real pen on any device so far (STATUS.md): all pen behaviour stays unverified until the owner tests by hand.
- The 10 known Windows test failures stay filtered out of check reports.
