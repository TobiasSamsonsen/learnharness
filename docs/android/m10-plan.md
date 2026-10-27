# M10 plan (DRAFT, conditional): native ink overlay

Status: **BUILT, merged and the default in the shell (2026-10-27).** The M9 decision was to build it (owner, 2026-10-27). The owner compared the Ink spike with the shell's web canvas by eye on the Pixel 7 Pro with a stylus: the web canvas' line trails the stylus by 2-3 cm at medium speed; on the spike it stays under the tip even without prediction ("day and night"). That is far past the proposed 30 ms rule, so the camera test is skipped. The build plan below is **proposed**; the owner decided A and B on 2026-10-27 (both as recommended) and has not yet said to start. The earlier sections (design questions Q1-Q7, accepted 2026-10-27) still stand except where the build plan says it refines them. Per AGENTS.md "No guessing", nothing is built before approval.

## Owner decisions (2026-10-27): all seven proposals accepted

Q1 bridge = origin-restricted `window.lhAndroid.ink` (`open/close/setHoles/export/undo/redo/clear/setTool`) through a `WebMessageListener` like M8's save bridge. Q2 opt-in "Native ink" switch in Settings, default off at first. Q3 vector strokes go to the web and the existing pure export makes the PNGs (one tested code path). Q4 tall pages scroll with the web's offset. Q5 the pen's eraser end and barrel button erase like the web canvas; hover does nothing. Q6 prediction on, colour follows the page. Q7 automatic fallback to the web canvas if the native view cannot be shown, said once. The overlay itself waits for the M9 camera numbers.

## BUILD PLAN (proposed 2026-10-27, after reading the web and Android code)

### What the code reading changed in the draft

1. **The owner's stylus is a finger to Android.** The Pixel 7 Pro has no stylus digitizer; a soft-tip capacitive stylus arrives as `TOOL_TYPE_FINGER`. The prepared `InkRouting.route` (feat/m10-prep) sends only stylus and eraser tool types to the ink layer, so this stylus would never reach it. The routing policy must be decided (Decision A).
2. **Strokes already travel as vectors, and rasterising is server-side** (resvg, `src/server/sketches.ts`; there is no grayscale step in `src/core`). So Q3(a) costs nothing extra: native strokes go into the same `SketchStroke[]` and the same `planSketch` / `sendPage` path.
3. **Two sources of truth is the real risk** (the draft said so). The web already owns the strokes, the undo/redo stacks, the kept page and the persistence (`ink-memory.ts`). Decision B proposes keeping it that way: native only draws and reports.
4. **Layer order.** The page canvas is an opaque white wrapper (`bg-white`) and the body paints `--color-background`. For the ink to sit *under* the toolbar and the floating box (which are web DOM) the WebView must be transparent while the native layer is open, and the page must stop painting the wrapper white. Whether a transparent WebView over `InProgressStrokesView` keeps the low latency on the Pixel is the first thing to prove (step 0).
5. `InProgressStrokesView` (1.0.0) is a `FrameLayout` with `setMotionEventToViewTransform` and per-stroke transforms in `startStroke`, so the web's scroll offset can be handled with a matrix instead of redrawing by hand.
6. The page is always white (`#ffffff`) and the web pen is `#111111`, size 4 (`SKETCH_PEN_SIZE`): "colour follows the page" (Q6) is one constant.

### Design

- **Bridge.** `WebMessageListener` named `lhAndroid`, origin-restricted exactly like `lhShell` (`MainActivity.installBridge`), main frame only. Web to native: `lhAndroid.postMessage(line)` with the prepared text lines (`open <key> x y w h`, `holes x,y,w,h …`, `tool pen|eraser`, `undo|redo|clear|close`) plus new ones: `strokes <json>` (the whole finished set, sent on open and after every undo/redo/clear/erase) and `scroll <y>`. Native to web through the listener's reply proxy: `stroke <json>` (one finished stroke), `erase <x,y,…>` (an eraser gesture), `fallback <reason>`. A small web shim exposes `window.lhAndroid.ink.*` so Q1's method shape holds. `export` from Q1 is dropped: the web already holds the vectors.
- **Native.** An `InkFrame` (FrameLayout) holds, bottom to top, a white page layer drawing the finished strokes (`CanvasStrokeRenderer`, with the scroll matrix), `InProgressStrokesView` with `MotionEventPredictor` (as in the spike, brush `#111111`, size 4 in CSS px), and the WebView (transparent). The routing sits in `InkFrame.dispatchTouchEvent`, because a view under the WebView never receives touches.
- **Web.** `components/sketch/use-native-ink.ts` reads `window.lhAndroid?.ink` and the Settings switch; `sketch-view.tsx` swaps `SketchCanvas` for a transparent placeholder that reports its rect (ResizeObserver) and scroll; `FloatingProblem.update()` reports the box as a hole (and the collapsed pill); ingest of `stroke` goes through the existing `addStroke`, `erase` through the existing `sketchStrokeHit` + `erase` (one undoable step), so undo/redo/clear/persistence/kept page/`pagePayload` are unchanged. `pagePayload` gets `producer: "android-ink"` when the surface is native. The Settings switch ("Native ink", Q2) only exists when the bridge exists.
- **Fallback (Q7).** If the shell cannot show the layer (bridge missing, layer error), it sends `fallback` once and the web keeps `SketchCanvas`, with one quiet line saying so.

### Steps

| # | Step | Done when |
|---|---|---|
| 0 | **Layering spike (gating, debug only).** Prototype on the Pixel: the lesson page in a transparent WebView over `InProgressStrokesView`, a DOM element above it. | Ink shows through, the DOM element stays above and clickable, touch routing by region works, the line still stays under the stylus (owner by eye; `ink-latency.mjs native` delivery numbers), and the capacitive stylus' tool type is logged. If it fails: the ink-above variant (strokes over the box), decided with the owner. |
| 1 | **Android main.** The ink dependencies move from `debugImplementation` to `implementation` (consider `abiFilters` arm64 to limit the APK growth from `libink.so`); `InkFrame`, `InkLayer`, `InkBridge`; routing state machine; fix the NaN/Infinity gap in `InkWire.parse` and `strokesJson`. | `./gradlew test lint assembleDebug` green; Kotlin tests for the routing policy (stylus seen or not, one finger, two fingers, holes, outside the rect, eraser end/barrel) and the wire. |
| 2 | **Web.** Merge `feat/m10-prep` (`ink-bridge.ts`) and extend it; hook, seam, hole/scroll/rect reports, transparent placeholder, Settings switch, fallback line. | typecheck, lint, full suite; the 13 `sketch-view` tests plus new ones with a fake `lhAndroid.ink` (open/close, holes follow the box, strokes ingest, erase as one step, undo round trip, fallback); the pen/touch policy gets its first tests. |
| 3 | **Device, over adb (injected touch).** | Draw, submit, tutor answers with the "I read:" card; undo/redo/clear; rotate; keyboard; back closes the sketch; close and reopen keeps the ink (the web pushes `strokes` on `open`); fallback path; delivery numbers. |
| 4 | **Owner on the phone.** | Feel with the stylus, two-finger scroll, a dense-notation sheet, a full lesson sketch; then the owner decides whether it becomes the default on the shell. |
| 5 | Docs, STATUS, merge. | |

Rough size: step 0 half a day, steps 1 and 2 about a day each, step 3 half a day.

### Risks

- Transparent WebView over the ink surface (step 0 exists for this): compositing cost, flicker on open/close, the page background that has to go while native.
- The keyboard (`adjustResize`) and rotation resize both views: the web re-reports the rect; the shell re-sends nothing on its own.
- Pinch zoom would break the CSS-px mapping: the sketch page must not zoom (to be confirmed in step 0).
- A very long page (up to 12000 px) redraws finished strokes only when they change.
- Live fade of strokes under the eraser (the web canvas does it) is not in the first version: the erase lands on lift.
- Process death drops native-only state, which is why Decision B keeps all strokes in the web store.

### Decisions (owner, 2026-10-27: both as recommended)

- **A. Input policy for touch.** DECIDED: mirror the web canvas. The stylus tool type draws; **until a real stylus has been seen, one finger draws too and two fingers scroll the page; once a stylus is seen, touch scrolls** (the web `penSeen` rule). On the owner's phone that means the capacitive stylus and a finger both draw, two fingers scroll.
- **B. Who owns the strokes.** DECIDED: the web store (`ink-memory.ts`) stays the single owner; native draws and reports strokes and eraser gestures, and the web pushes the finished set back.

### Build log (2026-10-27)

- **Step 0 (layering spike), passed.** Ink under a transparent WebView on the Pixel 7 Pro: the ink shows through, DOM above it (toolbar, floating box) stays above and clickable, region routing works, delivery median 1.0 ms, and the owner felt no difference from the old spike. The owner's soft-tip stylus reports `TOOL_TYPE_FINGER` (logged), which is why decision A matters.
- **Step 1 (Android), done.** `InkFrame`, `InkLayer`, `InkRouter` (decision A), `InkBridge` (`window.lhAndroid`), `InkWire`; the ink libraries are now normal dependencies. 27 JVM tests, lint clean. One bug found on the device and fixed: finished strokes must be drawn through the canvas transform (the renderer's own matrix argument drew them unscaled).
- **Step 2 (web), done.** `ink-bridge.ts` (final wire format), `use-native-ink.ts`, the sketch view seam, the transparent page while native (`html.lh-native-ink`), "Native ink" row in Settings (Appearance, shell only, default off), `producer: "android-ink"`. 10 new tests with a fake `lhAndroid`; one bug found by them and fixed (a redo of a native stroke was only acknowledged).
- **Step 3 (device over adb), done.** On the PC server through `adb reverse`, in a real lesson: the sketch opens on the native layer under the floating question box; strokes land in the web store with canvas-relative coordinates and are only acknowledged; undo/redo/erase round-trip (the shell redraws from the pushed set); the eraser removes the stroke it crosses as one undoable step; Back closes the sketch and the layer; reopening restores the ink; Submit sends `producer: "android-ink"` and the tutor's "I read:" card described the three strokes correctly; the Settings row shows in the shell. **Not testable over adb:** two-finger scroll (no multi-touch injection), a real active pen (eraser end, barrel button), rotation (a device setting), the fallback path (nothing makes the shell refuse on demand; it is unit-tested on the web side).
- **Step 4 (owner, on the phone with the capacitive stylus), passed (2026-10-27):** the feel is "much better, like the ink spike"; two-finger scroll works; the floating question box works; nothing smeared on notation; a resting hand leaves marks (expected: a capacitive stylus is a finger to Android, so the first one-finger touch draws until a real stylus has been seen); the tutor read the sketch correctly. Not tried: a touch on the box (the router's unit tests cover it) and rotation. **The owner made native ink the default in the shell**: on unless the "Native ink" setting (Settings, Appearance, shell only) is turned off.

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
