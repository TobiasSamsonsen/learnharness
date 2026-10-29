# M15: the fork's update card replaces the fullscreen update screen (Android)

Status: **BUILT 2026-10-29 on `merge/upstream-v0.4.0`; owner decisions and approval below.** Verification is in STATUS.md.

## Owner decisions (2026-10-29)

| Question | Answer |
| --- | --- |
| Where the card comes from | **Web card through the shell bridge.** The shell reports "update available" over `window.lhAndroid`; the page shows the card. No second, Kotlin-drawn copy of the look. |
| Buttons | **Update** and **Not now** |
| How long "Not now" lasts | **Until the next cold start** (the shell remembers it, so a page reload does not bring the card back) |
| Text | "A new version of LearnHarness is ready", "It downloads over Wi-Fi and the app restarts when it is done." and a **Release notes** link |
| Where Release notes goes | `docs/android/STATUS.md` on the fork's GitHub (there are no per-release notes) |

## What it does

- `begin()` no longer asks about updates before the app opens. After the page is loaded, `checkForUpdate()` looks at the release once per cold start, in the background (4 s timeout). `Flow.decide` lost its `updateAvailable` input and `Next.Update`.
- Wire (`UpdateWire.kt`, `components/android-update-card.tsx`): page sends `update probe` on mount; the shell answers `update available` when it has found a newer release (immediately if it already had, or later when the check finishes); `update start` and `update later` come back from the buttons.
- `update start`: the metered-connection check stays ("Connect to Wi-Fi"), then the shell stops the server (the files under it are replaced), runs the unchanged provisioning with its own fullscreen progress, starts the server and reloads the page.
- The card is mounted in the bottom-right stack of `app/layout.tsx` and renders nothing outside the Android shell.

## One addition the plan did not list

A phone whose installed server is **older than the card** never probes, so it would never be offered the update that brings the card. If the check finds an update and the page has not probed 8 s later, the shell falls back to the old fullscreen "Update available" screen (Update now / Later). It is only reachable on that first transition; newer servers always probe.

## Tests

`UpdateWireTest.kt` (parsing, routing by prefix, the answer line), `LogicTest` (flow without the update step), `tests/android-update-card.test.tsx` (text, buttons, link, the lines).
