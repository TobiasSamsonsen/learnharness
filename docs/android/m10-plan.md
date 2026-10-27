# M10 plan (DRAFT, conditional): native ink overlay

Status: **draft, not approved, and only needed if the M9 decision says so** ([m9-plan.md](m9-plan.md): build M10 if the camera median on the shell's web canvas is about 30 ms or more above the Ink spike's, or the dense-notation sheet is clearly worse on the web canvas). Written by Claude while the owner was away so the decision has something concrete behind it; nothing here is built. Per AGENTS.md "No guessing", every choice below that is not forced by the code is listed under "Questions for the owner" and nothing is implemented before they are answered.

## What is already decided (plan.md §2, §3, §7)

- The overlay is `androidx.ink`'s `InProgressStrokesView` (1.0.0, as used in the M9 spike) under a **transparent WebView**, inside the existing shell (`android/app`).
- The Activity routes **stylus** events (and, per the M7 note on touch, nothing else) to the ink layer; touches outside the floating-box rects that the web reports go to the ink layer too; touches inside the box, and all finger input, go to the WebView.
- It exports to the **same** `SketchPayload` (`src/core/contracts/sketch.ts`, `producer: "android-ink"`) through a bridge, `window.lhAndroid.ink`, so the web sketch view, the dock, the server and the tutor are unchanged. The web canvas stays the default everywhere else (desktop, Chrome).
- The mic stays in the web layer. Dictation, the floating question box, the confidence rail and Submit stay web UI; only the drawing surface moves.

## Built so far on `feat/m10-prep` (safe either way, no overlay yet)

- **Wire format, both sides.** `src/core/ink-bridge.ts` (`encodeInkOp`, `parseNativeStrokes`) and `android/app/.../InkWire.kt` (`InkWire.parse`, `InkWire.strokesJson`): one short text line per operation (`open <key> x y w h`, `holes x,y,w,h …`, `tool pen|eraser`, `undo|redo|clear|close|export`), and the export is a JSON array of `SketchStroke`, validated by the same rules as a web sketch. Because the contract already sends vector strokes and already allows `producer: "android-ink"`, **no server change is needed** (Q3 turned out to be the natural path).
- **Touch routing rule.** `InkRouting.route`: the pen (tip or eraser end) goes to the ink layer unless it lands on a hole (the floating box); fingers, mice and anything outside the surface go to the WebView; the target is decided once, on DOWN.
- **Tests:** `tests/ink-bridge.test.ts` (4) and `InkWireTest` (4, `./gradlew test`).
- **Not built (waits for the M9 decision):** the overlay view and the Activity layering under the transparent WebView, the `WebMessageListener` for `lhAndroid.ink`, the web seam in `SketchView`, the Settings switch (Q2) and the fallback (Q7). On the phone `adb shell input stylus swipe` may be able to drive a pen-typed touch for the later device tests (not checked yet).

## What the code already gives us

- `components/sketch/sketch-view.tsx` owns the toolbar, the floating box, undo/redo, Esc/back (`useBackLayer`) and the submit flow (`sendPage`, `pagePayload` in `components/sketch/ink-memory.ts`). `SketchCanvas` is the only part that draws. The overlay replaces `SketchCanvas` behind a seam (the view asks `window.lhAndroid?.ink` whether a native surface exists).
- The export rules (bbox crop, scale, bands, white background, grayscale PNG, new-ink bracket) are pure code in `src/core`; the plan wants the native side to reuse them. A native producer has two options for the pixels: (a) send vector strokes to the web and let the existing rules rasterise them; (b) rasterise natively and send PNGs. See Q3.
- M8's shell already reads insets, owns the WebView and has the debug-only spike to compare against.

## Proposed design (for the owner to accept or change)

1. **Web → shell**, when the sketch view mounts: `lhAndroid.ink.open({ inkKey, rect })` with the canvas rectangle in CSS px, and on every change of the floating box (drag, collapse) `ink.setHoles([rects])`. On unmount: `ink.close()`.
2. **Shell**: a second view (`InProgressStrokesView`) over the WebView's canvas rectangle, transparent WebView background while open, event routing by tool type (stylus to ink; finger/mouse to WebView; hover and the pen's eraser button handled per Q5). Finished strokes live in the shell as `Stroke` objects (ink's own model).
3. **Shell → web**: `ink.export(newSinceKey)` returns the strokes as a compact JSON (points with pressure, per stroke id, in page coordinates) and, if Q3 says so, a PNG per band. The web feeds the JSON to its existing export (identical output for both producers) and posts the `SketchPayload` as today.
4. **Undo/redo/clear/eraser**: buttons stay in the web toolbar and call `ink.undo()/redo()/clear()/setTool()`; the ink state is the shell's. Page persistence across a reload (the "kept page" from M1) uses the stroke JSON in the same `ink-memory` store.
5. **Tall pages**: the web canvas scrolls vertically; the native layer would translate by the web's scroll offset (reported by the web on scroll) or the page becomes a fixed viewport with a "next page" control. See Q4.

## Questions for the owner (nothing below is decided)

| # | Question | My proposal |
|---|---|---|
| Q1 | The bridge name and shape: `window.lhAndroid.ink` with `open/close/setHoles/export/undo/redo/clear/setTool`, installed by an origin-restricted `WebMessageListener` like M8's save bridge? | Yes, same mechanism as M8 (sandboxed demo iframes get nothing) |
| Q2 | Is the overlay Android-only and opt-in at first (a Settings switch "Native ink", default off until the owner has tried it), or on by default on a device that reports a stylus? | Opt-in first, default on later |
| Q3 | Where are the pixels made: (a) vector strokes to the web and the existing pure export rasterises (one code path, tested), or (b) the shell rasterises the PNGs? | (a), so both producers are tested by the same rules; the cost is serialising strokes |
| Q4 | Tall pages: scroll with the web's offset, or a fixed page with paging? | Scroll with the web's offset (matches M3 behaviour) |
| Q5 | Pen buttons and hover: eraser end and barrel button act as the eraser (like the web canvas today), hover does nothing? | Same as the web canvas |
| Q6 | Prediction: on (like the spike), with the brush from the spike (pressure pen, white-on-dark/black-on-white per the page)? | Yes; colour follows the page |
| Q7 | Fallback when layering fails on a device (the plan's M10 risk): keep the web canvas automatically if the native view cannot be shown, and say so once? | Yes |

## Tests and verification (if approved)

- **PC:** unit tests for the pure parts (event routing by tool type and hole rects, the stroke JSON round-trip, the bridge message parser), the existing sketch tests run with a fake `lhAndroid.ink` (the same M1-M3 interaction tests, as plan.md §7 M10 says), `./gradlew test lint`.
- **Phone (Claude over adb, finger-injected, as in M9; the pen parts are the owner's):** the overlay appears over the canvas rectangle and not over the floating box; a drag in the box's holes goes to the WebView; export produces a payload the server accepts and the tutor transcribes ("I read:" card); undo/redo; the back hook still closes the sketch view; delivery numbers from `scripts/ink-latency.mjs native` for the overlay.
- **Owner:** the camera numbers again (web canvas against the overlay, same protocol as M9), palm rejection with the real pen, and a dense-notation sheet on the overlay.

## Risks

- Layering a native view under a transparent WebView and routing touches by region is the milestone's real risk (plan.md §7); the fallback (Q7) exists for that reason.
- `InProgressStrokesView` front buffering needs a recent Android; the shell's minSdk is 31, which is enough in the M9 spike, but a tablet with an unusual compositor could behave differently.
- Two sources of truth for strokes (the shell's `Stroke` objects and the web's `ink-memory`) must stay in step across undo, clear and reload.

## Not in M10

Speak-while-sketching time anchors, a native erase-by-stroke tool beyond the web canvas's, a Compose rewrite, and any server change.
