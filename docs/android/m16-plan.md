# M16: sketch quality on par with popular note-taking apps

Status: **Approved by the owner 2026-10-29. M16a and M16b built (see STATUS.md); M16c and M16d next.** Branch `feat/m16-sketch-notes` (from `merge/upstream-v0.4.0`). Goal (owner, 2026-10-29): "improve the sketch feature and ui/ux so that it matches the quality of popular note taking apps". Source: a read-only gap analysis of `components/sketch/*`, `src/core/sketch.ts` and the Kotlin `Ink*.kt` against GoodNotes, Notability, OneNote and Samsung Notes (code reading only, no device).

## Owner decisions (2026-10-29)

| Question | Answer |
| --- | --- |
| Scope | All four bundles: UX polish, toolbar and gestures, drawing aids, Android stylus and stroke look |
| Straight lines | **Hold to straighten, plus a ruler tool** (the ruler was dropped later the same day, see below) |
| Highlighter | **No** |
| Stroke look on Android | **Android draws like the model's image** (the same perfect-freehand outline the server renders) |
| Toolbars | **Manual collapse, remembered, plus an "auto-hide while drawing" switch** (off by default) |
| Look of the bar (owner) | **Floating, rounded: a pill over the canvas**, option panels as rounded cards under it |
| Where the buttons live (owner, palm question) | **Everything at the top, one bar, nothing at the bottom.** Close, undo, redo, pen/eraser, paper, clear, mic and Submit in one row; tapping the active tool again opens a popover with the five colours, three widths and the eraser mode and size |

## Milestones

**M16a, UX polish (web).** Each item is a rough edge found in the code.
- The size and refusal state is visible while drawing: a live counter against the limits (3000 strokes, 250k points, 4 MB) that warns at 80 percent, and the refusal text in a readable, announced place (today it is an `aria-hidden`, truncated footer span).
- 44 px touch targets on touch screens for the action bar buttons, Submit and the problem pill's collapse button (`.lh-touch`).
- The "⌘↵ submits · esc closes" hint is hidden on touch-only devices, as in the question dock.
- The paper button shows the current paper in its icon, not only in a hover title.
- A blank canvas shows a faint hint; a disabled Submit says why ("Draw something first").
- One wording for the destructive button: the button and the dialog both say "Clear" (the dialog still says that sent ink stays).
- Keyboard parity: `[` and `]` change the pen width; holding Space pans (promised in M13c, never built).
- A failed send after the view closed must be visible to the learner (to be confirmed in the code: it is fire-and-forget today).
- Fix the stale comment in `sketch-canvas.tsx` about the native page scrolling.

**M16b, toolbars and gestures (web, native where the finger path allows).**
- **One top bar** replaces the pen strip and the bottom action bar (a resting palm sits below the pen, so the bottom edge is left empty). The pen options (colours, widths, eraser mode and size, and the auto-hide switch) open in a popover from the active tool; every control keeps its 44 px touch target. A handle collapses the bar to a thin tab; the choice is remembered per device. "Auto-hide while drawing" fades the bar while the pen is down and brings it back on lift (off by default).
- **Palm guard on the bars** (owner question, 2026-10-29: how do we stop the palm from hitting the bottom buttons? Answer: move them all to the top, and keep these cheap layers for the top bar too). Three layers, none needing a stylus to verify the logic:
  1. While a pen is down or hovering, and for 600 ms after, touch presses on both bars are ignored (the canvas already does this; the bars get the same check). The pen itself and the mouse are never blocked.
  2. A touch with a large contact area (a palm: `PointerEvent.width/height` of about 30 px or more, where the browser reports it) is ignored on the bars at any time.
  3. Nothing is at the bottom edge any more, and the bar hides while the pen is down when auto-hide is on. Clear already asks first.
  On Android the guard is the web's, using the pen hover and contact the page already receives; the Kotlin layer's rule that ignores a palm only with several pointers is made stricter in M16d (`FLAG_CANCELED`).
- Two-finger tap undoes (web; on Android the finger path in `InkRouter.kt` if it fits, otherwise web only and noted).
- Undo history of the **unsent** ink survives a reload (stored with the strokes in `ink-memory`). After a submit the history ends: sent ink stays protected, and is edited only through the eraser's existing "thaw".

**M16c, drawing aids.**
- *Hold to straighten:* at the end of a stroke, holding the pen still for about 0.5 s (less than 4 px of movement) replaces the stroke by a straight line from its start to its end. A line within 5 degrees of horizontal, vertical or 45 degrees snaps to it. One undo step; a short flash confirms. The native live preview shows the freehand stroke until the pen lifts and the web then swaps in the straight line (the web owns the strokes).
- *Ruler tool: built, then REMOVED (owner, 2026-10-29: "the ruler is not necessary, this is not supposed to be a note app, but just sketching for doing the questions you get").* The scope rule going forward: only what helps answering a question by sketch.

**M16d, Android stylus and stroke look (Kotlin).**
- Palm rejection also honours `FLAG_CANCELED`; the barrel button and a double press of the S Pen button toggle the eraser; a hover preview on the native layer.
- The native layer draws strokes with the same perfect-freehand outline as the server (parameters shared in one place), so the live stroke equals the model's image. Speed is checked on the Pixel.
- **Not verifiable here:** the stylus parts (barrel, double press, hover, `FLAG_CANCELED`) need a tablet and S Pen; only finger input on the Pixel 7 Pro is available. They are built defensively and listed as unverified in STATUS.

## Order and checks

M16a, M16b, M16c, M16d, each committed on its own with tests (pure logic in `src/core` or `components/sketch/*.ts` with unit tests; Kotlin unit tests for the wire and the geometry; whole suite at the end). Web behaviour is checked in the browser, Android on the Pixel over the dev loop with finger input.

## Decided by default (owner may change)

The popover opens by tapping the active tool again; the wording "Clear"; that undo history ends at submit; the thresholds above (hold 0.5 s, 4 px, 5 degrees, 24 px, 80 percent, palm contact about 30 px, guard window 600 ms); auto-hide off by default; the order.
