# learnharness Android shell (M8)

A thin Kotlin app (`dev.learnharness.android`, minSdk 31) around one WebView on the Termux server (`http://127.0.0.1:3000`). The UI is the web app; the shell adds what a browser tab can't: it starts the server, pairs by itself, grants the mic to the page, serves the file chooser, handles back, and gives the page real safe-area insets. Background: [docs/android/plan.md](../../docs/android/plan.md), [docs/android/m8-plan.md](../../docs/android/m8-plan.md).

## On the phone

1. Termux set up as in [../termux/README.md](../termux/README.md) (`lh` 0.3.0 or newer: `lh update`).
2. In Termux: `mkdir -p ~/.termux && echo 'allow-external-apps=true' >> ~/.termux/termux.properties && termux-reload-settings`.
3. Install the APK, open it, and allow **Run commands in Termux environment** (the app's *App settings → Permissions → Additional permissions*; the "Grant permission" button takes you there).
4. Open the app. If the server is down it runs `lh start` (up to a minute) and then `lh pair --print-token`; the token goes into the WebView's cookie jar and never onto a command line or the screen. After `lh pair --rotate` the server answers 403; the app re-reads the token once by itself.

The status screen names the one fix when Termux is missing, the permission is off, `allow-external-apps` is not set, or `lh` is old. Its port field changes the server port (default 3000).

## Build (Windows, macOS, Linux)

JDK 17+ (21 is what was used), the Android SDK with platform 37 and build-tools 37 (`ANDROID_HOME`, or `sdk.dir` in `local.properties`), then:

```sh
cd android/app
./gradlew test assembleDebug          # unit tests, then build/outputs/apk/debug/*.apk
adb install -r build/outputs/apk/debug/learnharness-android-debug.apk
```

`adb` over Wi-Fi works too (Developer options → Wireless debugging → `adb pair`, `adb connect`). Debug-signed APK only; there is no release signing or CI build yet.

## Dev mode (debug builds)

The status screen has a **Dev server (PC)** switch. On: no pairing, no Termux, the WebView loads `http://127.0.0.1:3000`, which is the PC's server through

```sh
adb reverse tcp:3000 tcp:3000
```

Run the PC side bound to `127.0.0.1`, without `LH_ACCESS_TOKEN` (so it has no gate):

```sh
npm run dev -- -H 127.0.0.1
```

The `-H 127.0.0.1` matters. A plain `next dev` answers the shell's `/_next` requests with 403 ("Blocked cross-origin request to Next.js dev resource"): the page's JavaScript never loads, the model pickers stay at "—" and Start stays disabled. (`allowedDevOrigins: ["127.0.0.1"]` in `next.config.ts` would also let it through; that is not set.) A production build works too: `npm run build`, then `npm run start` (it prints a warning that `next start` does not work with `output: "standalone"`; it still serves the build).

Stop the phone's own server first (`lh stop` in Termux): it holds the same port, and `adb reverse` fails with "Address already in use". The PC server has its own data directory, so the phone's chats are not there. `adb shell am start -n dev.learnharness.android/.MainActivity --ez lh.dev false` turns dev mode off again; run `lh start` in Termux. Remote debugging is on in debug builds (`chrome://inspect`).

## How it fits

- `Logic.kt`: everything testable without a device (flow decisions, token parsing, URLs, back order, inset script, redaction); `src/test/` covers it.
- `Termux.kt`: Termux's RUN_COMMAND service, with the result coming back through a `PendingIntent`.
- `MainActivity.kt`: the WebView, the status screen, permissions, file chooser, blob downloads (the page's `a[download]` blob click is handed to the system "create document" picker), edge-to-edge insets.
- Back: the shell dispatches `lh:back` to the page (`components/back-layers.ts`: the topmost open layer closes), then goes back in page history, then exits.
