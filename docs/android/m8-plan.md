# M8 plan: Android shell APK (`android/app`, Kotlin)

Status: **approved and implemented** (2026-10-27); results in [STATUS.md](STATUS.md). Parent: [plan.md](plan.md) §2 and §7 (M8). Inputs: M5 (safe-area vars), M6 (token cookie, Host/Origin gate, `/api/health`), M7 (`lh`, pairing link, token file). Track B: runs on the owner's Pixel 7 Pro. The shell loads the Termux server in a WebView; no web UI is rewritten.

## Owner decisions (this session)

| Topic | Decision |
|---|---|
| Build | The owner installs the Android toolchain on the PC (JDK, command-line SDK, platform-tools; Android Studio optional). I build with Gradle and install over USB with `adb`. No CI APK job in M8 |
| Pairing | The app reads the token itself: it runs `lh pair --print-token` through Termux `RUN_COMMAND` (result returned to the app) and sets the `lh_token` cookie through `CookieManager`. Needs one Termux setting (`allow-external-apps=true`) and the `RUN_COMMAND` permission. `lh` gets the new flag; the token is never on a command line |
| Server start | On open the app checks `/api/health`; if down it runs `lh start` through `RUN_COMMAND` and waits on a status screen. No Termux:Boot (boot autostart stays out of M8) |
| Back button | A generic web hook: layers register while open, the shell dispatches `lh:back` first, then WebView history, then exits. Shared app change (upstream-friendly), with tests |
| Native STT | Not in M8. The Android `SpeechRecognizer` becomes its own later milestone, measured first |
| Dev mode | A "Dev server (PC)" switch on the status screen, **debug builds only**. When on, the app skips pairing and start and loads `127.0.0.1:3000` (the PC's `next dev` through `adb reverse tcp:3000 tcp:3000`) |
| App ID | `dev.learnharness.android`, launcher label `learnharness` |
| minSdk | API 31 (Android 12): the tablet is not chosen, so Android 17 (the Pixel 7 Pro) cannot be the floor; 12 matches the phantom-process runbook in the README. `targetSdk` and `compileSdk` are the newest the installed SDK offers |

## Applied as the plan says (no choice left; shout if you disagree)

- **URL:** the WebView loads `http://127.0.0.1:<PORT>/` (PORT from the app's settings, default 3000), never `localhost` or `10.0.2.2`. The server's Host gate allows 127.0.0.1 and `getUserMedia`/`AudioWorklet` need a secure context; the cookie jar is per host name, so pairing and loading use the same host.
- **No `LH_ALLOWED_HOSTS` change:** the server listens on loopback only, so nothing else reaches it.
- **Stack:** plain Kotlin Activities and Views (no Compose: the status screen is a few text views and buttons), one WebView, AndroidX only. No Capacitor.
- **Screens:** `MainActivity` (the WebView) and a status view shown instead of it while the server is down, starting, or Termux is not set up (states: Termux missing, `RUN_COMMAND` not allowed, server down, starting, unpaired). Each state names the single fix (the exact Termux line to run or setting to change).
- **WebView:**
  - JS and DOM storage on, cookies accepted, third-party cookies off.
  - `WebChromeClient.onPermissionRequest` grants `RESOURCE_AUDIO_CAPTURE` for the app's own origin only; the shell requests the runtime `RECORD_AUDIO` permission before.
  - `onShowFileChooser` serves the three `<input type="file">` uses (materials, markdown import in home and graph) through the system picker.
  - Downloads: the page's `a[download]` click (blob URL, or the server's chat-export route) is intercepted in JS, read at once and posted through an origin-restricted `WebMessageListener` to the system "create document" picker (a `DownloadListener` would get a revoked blob URL too late).
  - Navigation outside `127.0.0.1:<PORT>` opens in the browser, never in the WebView.
  - SSE and `/api/events` stay open; backgrounding the app does not restart the page.
  - Remote debugging on in debug builds only.
- **Insets:** edge-to-edge window; the shell reads the real system-bar and cutout insets and writes `--lh-safe-top/right/bottom/left` onto `document.documentElement` after each page load and on every inset change (inline style beats the `:root` `env()` rule), so M5's padding gets real numbers without relying on WebView's `env()`. No web change.
- **Re-pair:** a 403 "Not paired" page (after `lh pair --rotate`) triggers one automatic re-read of the token through `RUN_COMMAND` and a reload.
- **`lh` changes:** `lh pair --print-token` prints the token alone (no link) and nothing else; `README.md` gets the Termux setting, the app permission and the install line. No change to the server.
- **Web change (generic):** `components/back-layers.ts` keeps a stack of "close me" handlers; the sidebar drawer, sketch view, settings, session overlay, skill map, graph panel and the confirm dialogs register while open. A `lh:back` window event pops the top layer and sets `detail.handled = true`; the shell reads that flag. Dictation cancel and the abort dialog are never reached by a synthetic Escape. Escape key behavior stays as it is.
- **Docs:** `android/app/README.md` (toolchain, build, install, the Termux setting, dev mode), STATUS.md entry for M8, and `.gitignore` entries (`android/app/build/`, `.gradle/`, `local.properties`, `.idea/`, `*.apk`, `*.keystore`). eslint and tsconfig already skip nothing under `android/`; Gradle output contains no `.ts`/`.js` the linters would pick up, so no config change.

## Tests (on the PC)

- Kotlin unit tests (JUnit, `./gradlew test`) for the pure parts: token extraction from the `RUN_COMMAND` result, pairing-URL and health-JSON parsing, the state machine (health down → start → wait → paired → load), the back dispatcher order (web layer → history → exit), the 403 re-pair rule, the inset-to-CSS script.
- `tests/android-lh.test.ts` gains `pair --print-token` (stdout is exactly the token; mode 600 unchanged).
- A web test for `back-layers` (stack order, handled flag, unmount cleanup) in the linkedom pattern, plus a render test that the sketch view and the drawer register.
- `./gradlew assembleDebug` and `lint` clean; `npm run typecheck`, `lint`, `npm test` (10 known Windows failures).

## Verified on the phone (by me, over adb once USB debugging is on)

Install the debug APK; with the server stopped, the app starts it through `RUN_COMMAND` and loads the app paired; kill and reopen; `lh pair --rotate` then reopen (automatic re-pair); the mic prompt and a dictation request reaching the nb whisper server; a file chooser upload; a blob download; back from the sketch view, the drawer and a chat; the insets on the gesture bar and cutout (screenshots); dev mode against the PC server through `adb reverse`.

## Left to the owner (needs hands on the phone)

Set `allow-external-apps=true` in Termux and grant the app the Termux run-command permission; a full lesson inside the shell (the M7 checklist: sketch by pen or finger, voice, a demo, a restart that survives, a screen-off turn with the wake lock).

## Changed while building (off the plan as approved; say if you disagree)

- **Web, beyond "no web change":** M5's safe-area padding was missing on the home and graph views' top-right chrome (the pill sat under the status bar in the shell), so those two class strings now add `var(--lh-safe-top/right)`. Back layers are registered in more places than the plan listed (dialogs, popovers, Settings sub-menus, find bar), so back never closes a whole dialog over an open menu.
- **Bridge:** `WebMessageListener` limited to the server's origin instead of `addJavascriptInterface` (the latter would also be injected into the sandboxed demo iframes).
- **Loop guard:** after `lh start` succeeds but nothing answers on the app's port, the app stops and says so.

## Not in M8

CI APK builds and release signing, Termux:Boot autostart, the native speech recognizer, the native ink overlay and the `lhAndroid.ink` bridge (M9/M10), any server code change (none expected; if the device shows one, I stop and ask), the performance and lifecycle work (M11).

## Risks to watch

- Termux must come from F-Droid or GitHub (the Play Store build is outdated) for `RUN_COMMAND`; the status screen tells the user when it is missing.
- Android can kill the Termux child processes under memory pressure (M7 runbook); the shell only reports and restarts, it does not fix that.
- `RUN_COMMAND` returns output through a `PendingIntent`; if the token result does not arrive on the device, I stop and ask rather than fall back to a paste screen.
- WebView and Chrome differ (permission prompts, `env()`, contextmenu); the M5 long-press hardening is checked in the shell, not assumed.

## To confirm when you approve

The Android Gradle plugin and Kotlin versions (I propose the current stable ones that the installed SDK supports) and where the debug signing key lives (the default debug keystore on the PC).
