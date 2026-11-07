# Sketch performance with many strokes (2026-11-07)

Branch `perf/sketch-many-strokes`. The owner reported the sketch UI slowing down on a page with many strokes. **Native ink is the
priority; the web canvas is a fallback and is barely used.** Most of this branch is web-canvas work, so read the native section first.

## Native ink (the priority): measured 2026-11-07, then fixed (see "What was fixed")

Setup: Pixel 7 Pro (debug APK 0.5.0, 120 Hz, screen at brightness 11, off the charger), PC dev server, `/dev-sketch` seeded with N
wavy strokes of 40 points, native ink ON, real finger swipes for drawing, `dumpsys gfxinfo` for frames, per-thread CPU from
`/proc/<pid>/task/*/stat`, battery `current_now` (noise about ±10 mA, so only large power differences are real). The WebView runs JS on
the app's main thread, so JS and Kotlin costs share one thread. Caveat: JS numbers come from the React **dev** bundle (inflated); the
Kotlin numbers are for the debug build (CheckJNI is on, which taxes JNI-heavy work), which is also what the owner's phone runs.

**1. Pan/zoom redraws every stroke, uncached: the page becomes unusable.** A stream of `view` lines (one per frame), no JS involved:

| strokes | frames/s | frame p50 | janky | app CPU | battery current |
|---|---|---|---|---|---|
| 0 | 120 | 8 ms | 0% | 92% of a core | 470 mA |
| 300 | 112 | 15 ms | 3% | 93% | 1225 mA |
| 1000 | 50 | 44 ms | 61% | 96% | 1300 mA |
| 2900 | 7.5 | 130-150 ms | 100% | 120% (main 14.6 s + RenderThread 7.2 s per 15 s) | 1300 mA |

About 0.045 ms per stroke per frame, on the UI thread: `FinishedStrokesView.onDraw` re-runs `renderer.draw` for every stroke on every
invalidate, with no bitmap cache, no culling, and a `saveLayerAlpha` while sent ink exists (`InkLayer.kt:35-39, 225-248, 163-166`).
Even with 0 strokes a view stream costs a whole core and 470 mA: WebView compositing (`VizWebView`, ~29%) and `RenderThread` (~45%) run
every frame because the native layer invalidates the window. Through the page's own zoom (wheel, so React re-render plus the CSS paper
dots) the GPU thread `Chrome_InProcGp` adds another 5 s per 15 s and the empty page reaches 820 mA: the paper dots are re-rastered per
view change.

**2. Every full `strokes` push blocks the UI thread: about 1 ms per stroke.** Undo, redo, clear, pixel-erase, thaw and opening a page
push the whole set (`use-native-ink.ts:258`). Kotlin parses it and rebuilds every stroke (`InkWire.strokes`, then `InkLayer.drawn()` →
`toInk()` per stroke: a new `Brush`, `InkSmooth.densify`, a `MutableStrokeInputBatch` of every point; `Regex` compiled per stroke).
Measured by posting `strokes <json>` straight to the shell: 2900 strokes = one 2.9 s frame (main thread 16.5 s CPU over 6 pushes,
100% janky), 300 strokes about 0.37 s, 18 strokes about 0.17 s per undo (mostly dev-mode JS there). The cap is 3000 strokes, and Android
raises an ANR at 5 s of blocked input, so the margin is thin on a slower phone. The page is frozen for the whole push.

**3. Pen-down and pen-up each redraw everything.** `setLive(null)` invalidates the finished view unconditionally (`InkLayer.kt:169-172`),
called on every DOWN and UP, plus `addPending` / `ackPending`: about 4 full redraws per stroke. On 2900 strokes drawing 17 strokes
gave 81 frames, all janky, p50 133 ms: each pen-down and pen-up stalls about half a second. On an empty page the same swipes were
20% janky (p90 34 ms), so there is a fixed per-stroke cost as well (the stroke message, the React render, `ack`).

**4. One stroke leaves a 120 Hz frame-callback loop running (found by profiling).** Idle app CPU is 1.2% of a core on a fresh start and
**11%** after a single stroke has been drawn, and it stays until the app is force-stopped (closing the sketch view does not stop it; the
layer is `GONE` but the callback runs). `simpleperf` (`simpleperf record --app dev.learnharness.android -e cpu-clock --call-graph
dwarf,8192`) shows the main thread dispatching VSYNC every frame into `androidx.ink.authoring.FinishedShapesView.choreographerCallback`,
which re-posts itself (`Choreographer.postFrameCallback`) without ever drawing (no frames are rendered). The app does call
`removeFinishedStrokes` from its listener (`InkLayer.kt:397-400`), so this looks like androidx.ink 1.0.0 behaviour (dependency in
`android/app/build.gradle.kts:62-68`). The battery-current difference was inside the noise (fresh 170 mA, after a stroke 180 mA, an
older residue state 167 mA), so this is a CPU/wakeup finding, not a proven milliamp one: it keeps the SoC out of deep idle at 120
wakeups a second.

**5. Smaller things.** Hover ring invalidates a full-size view on every hover move (`InkLayer.kt:310-318`). The stroke eraser's fade does
`xyOf(points)` over the whole gesture path on every move, O(L²) per gesture (`InkLayer.kt:567`). Pixel-erase sends the whole path to JS,
which runs `sketchStrokeCut` over every stroke and then pushes the full set back (point 2). Two debug tools are off: `InkSpikeActivity`
never clears `dispatchMs`, so `scripts/ink-latency.mjs native` overstates (and it measures the standalone spike, not the real sketch).

### What was fixed (branch `perf/native-ink`, 2026-11-07)

Items 1-4 are in the shell (`android/app/src/main/kotlin/dev/learnharness/android/`), items 5-6 in the page. No wire-protocol change.

1. **`FinishedStrokesView` is now cached and culled** (own file; `InkCache.kt` holds the testable maths). Each stroke is converted to
   ink once, only when it first meets the view, and recorded once into a `RenderNode`; the visible strokes are drawn into one GPU
   layer (the screen plus 25% each side) that the frame only blits, moves and scales. The layer is rebuilt when the ink changes or the
   view leaves it, and, once the view is still, at exactly that view so it is drawn one-to-one (crisp). After a zoom the strokes are
   recorded again at the new scale a few ms per frame (progressive sharpening, the owner's pick over a 0.15 s freeze).
   A recording the system has dropped (HWUI frees a node's display list when a frame leaves it out) is detected with
   `RenderNode.hasDisplayList()` and made again: an early version showed an empty page after "clear, then push" and after erase + undo
   until this was handled (verified pixel-exact now).
2. **A full `strokes` push reuses what it already converted.** Strokes are keyed by content (`StrokeKey`), so undo, redo, clear-undo and
   cut convert only strokes that are new. The reader for the push is `InkJson`, a scanner for exactly the JSON the page writes (falls
   back to org.json on anything else; tests check both agree on random pages and edge cases): 520 ms -> about 60-90 ms for 2900 strokes.
3. **The idle frame-callback loop is gone.** After the first finished stroke the library's `FinishedShapesView` (which only draws strokes
   handed to it, and ours are drawn by `FinishedStrokesView`) is taken out of the tree, found by class name so a newer library is left alone.
4. Smaller: `ackPending` and `setLive(null)` no longer invalidate when nothing changed; the colour `Regex` is not rebuilt per stroke;
   `allRaw()` is cached.

5. **The paper no longer re-rasters on every view event** (`components/sketch/native-paper.tsx`, maths in `sketch-background.ts`). It is
   drawn for a base view on an element that overhangs the canvas by 25% each side; a pan or zoom only sets a compositor transform on it
   (no raster, and no React render: `useNativeInk` now publishes the view through `viewRef` / `onView` instead of setting state per
   event), and the paper is drawn again for the new view once the view has been still for 140 ms or has left the element. The dots are
   briefly scaled (a little soft) during a zoom, like the ink. GPU thread `Chrome_InProcGp` during a wheel zoom: 5.1 s -> 1.9 s per 15 s.
6. **Pushes and saves write each stroke's JSON once** (`strokesJson` in `src/core/ink-bridge.ts`, used by the `strokes` / `kept` push and
   by `ink-memory.ts` persistence): a stroke is never edited in place, so its text is kept and the page is joined from it. The page-side
   cost of an undo went 130 ms -> 64 ms, and the debounced save during drawing went from 62-190 ms long frames to about 52 ms
   (what is left is mostly the 2 MB `localStorage.setItem`).

Measured on the Pixel 7 Pro, 2900 strokes, native ink, debug APK (before -> after):

| | before | after |
|---|---|---|
| Pan: frames/s, janky, battery current | 7.5 fps, 100%, 1300 mA | 118 fps, 1.7%, 812 mA |
| Zoom: frames/s, janky | 7.5 fps, 100% | 108 fps, 3.9% (793 mA) |
| Full push (undo, redo, cut, open): UI thread | 2900 ms | 130 ms (parse 60-90 ms + apply 30 ms) |
| Drawing: frame p50, janky, current | 133 ms, 100%, 634 mA | 12 ms, 37%, 451 mA (empty page: 415 mA) |
| Idle after one stroke: CPU | 11% of a core | 0.3% |
| Undo/redo cycle through the page | about 3 s | about 0.1 s (frames p50 81 ms) |

Verified on the device by screenshot: a pixel-eraser gesture and a stroke-eraser gesture (touched strokes fade, then go) each undo to a
page with 0 differing pixels; the live preview and the committed cut differ by under 600 px; a zoom ends crisp; rendering matches the
previous build (same lit-pixel count and brightness in the same region). Unit tests: `InkCacheTest` (8), `InkJsonTest` (6), all 114 existing
Kotlin tests pass.

### Not done, and why

1. **`applyView` is not coalesced.** Not measured with real fingers (two-finger input cannot be injected over adb). What was measured:
   with the wheel, one `view` line per frame (1738 events in 15 s at 116 fps). What is assumed, from how Android delivers touch: it batches
   `MOVE` events to the frame, and the shell sends one `gesture` line per `MOVE`, so a gesture should not send more than one `view` per
   frame either. If a real two-finger gesture turns out to send more (log the `gesture` lines per second in the page), coalescing
   `applyView` to one `requestAnimationFrame` is a small change in `use-native-ink.ts` (the gesture test then needs a frame wait).
2. **Pan on a dense page is at its floor.** 812 mA against 473 mA for the same view stream on an empty page: what is left is the window
   frame (WebView compositing plus the layer's blit) at 120 Hz, and the layer's rebuild whenever the view leaves its 25% margin. A bigger
   margin would trade a 40 MB texture for fewer rebuilds; not worth it until a real pan on a real page shows a need.
3. **The page still pushes the whole stroke set on undo, redo and cut.** With items 2 and 6 the cost is about 60 ms in the page and
   130 ms in the shell at 2900 strokes (from about 3 s). An op-based push would remove most of it. Design worked out, not built:
   `edit <from> <rm> <at> <json>` (the store only removes strokes, inserts new ones and keeps survivors in order and as the same objects,
   so the page can diff by identity), the shell announcing `caps edits` in answer to the page's `caps` (an older shell stays silent, so a
   newer page keeps pushing whole), and a `resync` line when an edit does not fit what the shell holds. It is a protocol change between
   two things installed separately (the shell APK and the web app), so it needs both sides and tests; it was started and dropped.
4. **Saving is still a whole-page `localStorage` write** (about 52 ms, 500 ms after a pen-up, off the pen-up instant). Chunked or
   append-only storage would remove it but changes a stored format users already have; not worth it for 50 ms.
5. The stroke eraser's fade still converts the whole gesture path per move (O(L^2)); the hover ring invalidates a full-size view. Neither
   measured as a problem.

Not measured: a real stylus (cannot be injected over adb), input-to-photon latency, and a production React bundle. The installed debug
APK on the Pixel is the new build.

## Native ink: what code reading predicted (before measuring)

The changes in this branch that reach the native path are:

- **Debounced persistence** (`ink-memory.ts`): shared by both paths. See "Still slow" below.
- **Per-render scans** (`sketch-view.tsx`, `sketch-status.ts`): `limitShare` / `hasNewInk` / the undo check are memoized on stroke identity.

Known from reading the code, not yet measured, and not changed here (`components/sketch/use-native-ink.ts`, `ink-bridge.ts`):

- Any ink change that is not a single append (undo, redo, clear, erase, cut) pushes the **whole** stroke array to the shell as
  `strokes <json>` (`use-native-ink.ts:250-261`, `encodeInkOp` → `JSON.stringify(op.strokes)`): O(all strokes) per such change.
- The kept page is re-sent whole whenever it changes (`use-native-ink.ts:262-264`).
- `applyView` runs `setViewState`, `setZoomPct` and a `postMessage` on every pan/zoom event with no throttle
  (`use-native-ink.ts:116-127`, `use-view-gestures.ts:50-61`), and its host is `SketchView`, so the whole view re-renders per event.
- The eraser's hit-test per gesture (`eraseHits`, `sketchStrokeCut` in `cut()`) is O(strokes) with a bounding-box reject.
- Drawing itself happens in the Android shell, outside this repo; its cost with thousands of strokes is unknown.

(The measurements above confirm the full push, the per-event view cost and the O(strokes) draw; they also found points 1, 3 and 4.)

## What was slow in the web canvas

`SketchCanvas.draw()` cleared the canvas and refilled **every** stroke on **every** frame (pen move, hover, pan, pinch). No cached
layer, no culling: cost O(all points on the page), up to the caps (3000 strokes, 250k points). The pixel eraser re-cut every stroke
every frame with uncached `Path2D`s. Also: a fresh `[]` default for `kept` re-ran the draw effect each render; the pen's hover circle
forced a full redraw per hover move.

## What changed

- **Cached ink layer + culling** (`components/sketch/ink-layer.ts`, `sketch-canvas.tsx`): committed ink is drawn into an offscreen
  bitmap covering the viewport plus 25% each side, filling only strokes whose bounds meet that region (`sketchStrokeBounds` is now
  exported from core). A frame is a blit plus the live stroke. A new stroke is painted onto the layer; pan/zoom blit the bitmap with
  the new transform and redraw it sharp 140 ms after the view stops.
- **Pixel eraser** cuts only the new stretch of the path against strokes near it (`advanceCut`), pieces cached as paths; the strokes
  it is showing live are left out of the layer and drawn on top.
- **Redraw churn:** stable `kept` default; the pen no longer shows a hover circle (the OS already shows one), the eraser still does.
- **Persistence:** writes wait 500 ms after the last change and flush on `pagehide` / hidden; a refused write (quota) now shows
  "Couldn't save this page on this device. Send it soon so the ink isn't lost." in the status line instead of being swallowed.
- Tests: `sketch-ink-layer`, `sketch-ink-persist`; `sketch-history` and `sketch-native-ink` flush before they read storage.

## Measured (Pixel 7 Pro, web canvas, 2900 seeded strokes of 40 points, dev server, WebView over CDP)

| | before | after |
|---|---|---|
| Pan, frames over 33 ms | 4 (worst 74 ms) | 0 (worst 18 ms) |
| Zoom, frames over 33 ms | 7 (worst 132 ms) | 0 (worst 12 ms) |
| Pan / zoom p95 frame | 25.9 / 39.8 ms | 9.8 / 9.3 ms |
| Finger drawing p95 frame | 16.7 ms | 8.4 ms |

Rendering is equivalent: lit-pixel counts at 10%, 45% and 201% zoom differ by under 0.02% from the old canvas. Both erasers verified on
the device (stroke mode: touched strokes fade, then go whole; pixel mode: live preview 163,555 vs committed 163,539 lit pixels; undo
restores). The old canvas was fast on a near-empty page (8.3 ms frames), so the slowdown only shows with a dense page.

## Still slow

- **The persistence write is O(page).** About 500 ms after a pen-up the debounced write stringifies the whole page and writes
  ~2 MB to localStorage: 50-75 ms typical (stringify ~25 ms + `setItem` 21-49 ms), up to ~190 ms seen under load. The debounce moved it
  off the pen-up instant; it did not remove it. This applies to **native ink too**. Fix: store only new strokes (append-only chunks),
  or write in idle time. A kill with no `pagehide` loses up to the last 500 ms of ink.
- **Submit** re-plans and re-renders the whole page client and server (`parseSketchPayload` → `planSketch`, `persistInputSketch`
  with resvg for every page). Not touched; it is submit latency, not drawing lag.
- The live stroke is re-outlined from all its points each frame (low impact).
- The stroke eraser's `eraseAt` still scans all strokes per pointer move (bounding-box reject; medium on very dense pages).

## Pre-existing problems found on the way (not fixed)

- **Ink vanishes at 800% zoom** on the dense test page: zero lit pixels while panning across it, in the old canvas too. Not yet known
  whether those spots were empty or the canvas fails at the maximum zoom.
- **A page restored with more than 3000 strokes comes back empty.** `restoreStrokes` validates with `parseSketchPayload`, which
  rejects over `SKETCH_MAX_STROKES`, and the view lets you keep drawing past the cap ("This page is full" is only a warning).
  Reloading then loses the whole page. This cost a baseline run here.

## How it was measured (the Pixel loop is in memory `pixel-device-verification-loop`)

Dev server on a throwaway `LH_DATA_DIR`; `adb reverse`; app started with `--ez lh.dev true`; CDP over `adb forward`. Native ink had to be
turned off for the web canvas to mount (`localStorage lh:native-ink = off`; remove the key afterwards, absent means on). `/dev-sketch`
with ink key `dev-sketch` was seeded with a deterministic generator (keep under 3000 strokes). Pan and zoom: synthetic `WheelEvent`s on
the canvas, one per `requestAnimationFrame`, recording the frame intervals. Drawing: `adb shell input swipe` (real touches) while a
rAF loop and a long-task observer recorded. Long-frame attribution: a `long-animation-frame` observer showed the hitch was `flushInk`.
The baseline was taken by stashing the changes (a first baseline was invalid: the page had passed 3000 strokes and reloaded empty).
