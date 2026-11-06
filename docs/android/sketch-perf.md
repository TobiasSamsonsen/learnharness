# Sketch performance with many strokes (2026-11-07)

Branch `perf/sketch-many-strokes`. The owner reported the sketch UI slowing down on a page with many strokes. **Native ink is the
priority; the web canvas is a fallback and is barely used.** Most of this branch is web-canvas work, so read the native section first.

## Native ink (the priority): not measured, and what is known

Nothing in this branch was measured with native ink on. On the Pixel, native ink is on by default (`lh:native-ink` absent), and the web
canvas is not even mounted (`sketch-view.tsx`: `native.active ? … : <SketchCanvas>`). The changes that reach the native path are:

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

**Next step for native:** seed a dense page under a throwaway ink key with native ink ON, and measure pan/zoom event handling, undo
after a big erase (the full-array push), and pen-up. A stylus cannot be injected over adb, so the pen path needs the owner's hands.

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
