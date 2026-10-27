# M9 plan: ink decision gate (web canvas or native ink?)

Status: **spike and software numbers done; camera test and decision wait for the owner** (2026-10-27). Parent: [plan.md](plan.md) §2 and §7 (M9). Inputs: M3 (the web sketch canvas), M8 (the shell). The owner is away from the phone, so everything that does not need a camera or a pen was done by Claude over `adb`; what is left is in [phone-todo.md](phone-todo.md).

The question M9 answers: is the WebView's sketch canvas good enough for handwriting on the tablet, or is the native `androidx.ink` overlay (M10) worth building? M9 builds nothing for the product. It produces numbers and a screen to film.

## Owner decisions

| Topic | Decision |
|---|---|
| What to build without the owner | A debug-only native "Ink spike" screen, software probes for the part of latency that needs no camera, and a protocol with a result table. The camera test and the notation test stay with the owner ("do whatever you can without me") |
| Library | `androidx.ink` 1.0.0 (stable, as in plan.md §2), with `androidx.input:input-motionprediction` 1.0.0; debug builds only |

## Applied as the plan says (no choice left; shout if you disagree)

- **Spike screen** (`android/app/src/debug/…/InkSpikeActivity.kt`, debug source set, so the release APK has no ink dependency): `InProgressStrokesView` (front-buffered) under a view that draws finished strokes with `CanvasStrokeRenderer`; `requestUnbufferedDispatch`; motion prediction with an on/off button; a Clear button; the pressure pen brush, white on the app's `#141414`; any pointer type draws (so injected touch works). Start it with `adb shell am start -n dev.learnharness.android/.InkSpikeActivity`.
- **What the software probes measure ("delivery"):** how long an input event waited before the app's code saw it: web `performance.now() - event.timeStamp` in a `pointermove` handler (plus the time to the next `requestAnimationFrame`), native `uptimeMillis - eventTime`. Both read the hardware timestamp, and both are driven by the same injected `adb shell input swipe` (a long diagonal, 900 ms, five swipes each way), so the two stacks see the same input. This is the part of the latency before either stack can draw; it is **not** photon latency, and the injected touch is not a pen.
- **`scripts/ink-latency.mjs`:** `web`, `native` (both over `adb`; the web probe needs a debug build) and `frames --fps 240 <counts…>`, which turns slow-motion frame counts into milliseconds (4.17 ms per frame at 240 fps). Tested in `tests/ink-latency.test.ts`.

## Software numbers (Pixel 7 Pro, 120 Hz, injected touch; 2026-10-27)

| Stack | Samples | Delivery median | p90 | max |
|---|---|---|---|---|
| Native spike (`uptimeMillis - eventTime`; the clock has 1 ms resolution) | 5940 moves | **1.0 ms** | 1.0 ms | 6 ms per stroke at worst |
| WebView page (`performance.now() - timeStamp`) | 1015 moves | **9.7 ms** | 11.1 ms | 19.4 ms |
| WebView page, event to the next animation frame | 1015 | 6.6 ms | 7.4 ms | 16.4 ms |

Reading: Chromium delivers continuous input once per frame (the event waits for the next vsync, about 8.3 ms at 120 Hz), so the web stack starts drawing about 9 ms later than the native one before any drawing has happened. The native path then draws into the front buffer; the web path draws in a rAF and goes through the compositor, so the gap in photon latency should be larger than these 9 ms. How much larger is what the camera is for. Not measured: a real pen (EMR or active), pen prediction in Chrome (`getPredictedEvents`) and the desynchronized canvas hint, because they need the pen.

## The camera test (owner, with a 240 fps slow-motion camera)

For each of (a) Chrome on the app's sketch canvas, (b) the shell's sketch canvas, (c) the Ink spike screen:
1. Film the pen tip and the screen together, camera fixed, 240 fps.
2. Draw three fast circles, then one long diagonal stroke; three takes.
3. In the video, step frame by frame and count the frames between the pen tip and the ink tip at the same moment (the ink lags behind the tip; count at a point of steady motion).
4. `node scripts/ink-latency.mjs frames --fps 240 <the counts>` prints the median and p90; write them into the table below.

| | Counts (frames) | Median ms | p90 ms |
|---|---|---|---|
| Chrome, web canvas | | | |
| Shell, web canvas | | | |
| Ink spike, prediction on | | | |
| Ink spike, prediction off | | | |

## Dense-notation test (owner)

Write this sheet once on the web canvas (shell) and once on the Ink spike screen, at your normal handwriting size, without slowing down:

1. `x_{i+1}² − y_n^k` (stacked sub- and superscripts)
2. a 2×2 matrix in brackets, with a determinant bar on the other side: `[a b; c d] = |a b; c d|`
3. `∫₀^π sin²x dx = π/2` (limits on the integral)
4. `√((a² + b²) / 2c)` (a fraction inside a root)
5. `Σ_{k=1}^{n} k = n(n+1)/2`

Judge: did small marks (sub/superscripts, dots, the integral's limits) stay crisp and in place, did fast strokes turn angular or smeared, did the web canvas drop a stroke? A screenshot of each goes in the repo notes or in the chat.

## Decision rule (proposed; the owner decides)

Build M10 (the native overlay) if the camera median on the shell's web canvas is more than about 30 ms above the Ink spike's, **or** the owner finds the dense-notation sheet noticeably worse on the web canvas. Otherwise keep the web canvas and spend the effort on M11. If the numbers fall in between, the web canvas ships first anyway (plan.md §2), and M10 stays an upgrade.

## Not in M9

The overlay itself (M10), `lhAndroid.ink` and the sketch-payload bridge, a pen in the automated probes, Chrome-for-Android automation, and any change to the web canvas (M9 only measures it).

## Risks to watch

- The injected-touch numbers cannot see pen-specific behaviour (pressure, tilt, hover, palm rejection, the pen's own sample rate); they only compare the delivery stage.
- `androidx.ink` 1.0.0 front-buffering needs a recent Android and a device that supports it; the Pixel does. A tablet that does not would fall back to ordinary drawing, which would change the result.
- The Ink spike keeps its strokes on a plain canvas view; the real overlay would sit over a WebView, where layering and touch routing (M10's risk) have not been tested.
