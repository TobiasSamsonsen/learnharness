# learnharness for Android (M12: standalone)

One APK, no Termux. A Kotlin shell (`dev.learnharness.android`, minSdk 31, arm64 only) around one WebView, with the whole server inside the app: the shell downloads a small Linux environment on first run, starts the Next server in it under `proot`, signs in to Claude, and loads the UI from `http://127.0.0.1:3000`. The Claude subscription is used (the `claude` CLI runs in the app's Linux environment). Background: [docs/android/m12-plan.md](../../docs/android/m12-plan.md) (the plan, the spike results and the decisions), earlier milestones in [docs/android/plan.md](../../docs/android/plan.md). The old Termux setup is still in [../termux/](../termux/) and no longer used by this app.

## For the learner

1. Install the APK and open it. The first run downloads the Linux environment and the server and installs the Claude CLI (about 300 MB; keep the app open).
2. Allow notifications when asked: the server runs as a foreground service, and Android shows its notification while it runs.
3. Sign in to Claude: **Open the sign-in page**, sign in, copy the code the page shows, paste it into the app. That is the whole setup.

Dictation uses Android's on-device speech recognizer (no audio leaves the phone). If the offline pack for a language is missing the microphone button says so and Android starts downloading it.

## How it works

- `Guest.kt`: where the guest lives (`files/rootfs`, replaceable; `files/home` = `/root`, the learner's data and Claude login, survives updates; `files/server` = `/opt/lh/server`) and the one place that builds a `proot` command line. `proot` and its loader ship as `lib*.so` (Android only executes files from the native library directory; `scripts/fetch-proot.py` downloads them from the official Termux packages, checks pinned sha256, and nothing is committed). DNS is written from the phone's own resolvers at every start.
- `Provisioner.kt`: first run and updates. Downloads `learnharness-rootfs-linux-arm64.tar.gz` (release `android-rootfs`, built by `android/rootfs/build.sh`) and `learnharness-server-linux-arm64.tar.zst` (release `android-latest`), checks each sha256, unpacks the rootfs with Android's `tar` and the server inside the guest (`zstd`), then `npm install`s the claude CLI at the version this app pins (`Release.CLAUDE_VERSION`) into the home. A different remote version means "update".
- `ServerService.kt`: a foreground service (`specialUse`) with a partial wake lock. It runs `node server.js` as a direct child of the app (no shell in between) and restarts it if it dies. The pairing token is made once and kept in private storage; the shell writes the `lh_token` cookie itself.
- `ClaudeLogin.kt`: `claude auth login` under `script` (a pty), its stdin a pipe the shell keeps open; the link is read from the output, the pasted code written back.
- `DemoBridge.kt`: the demo browser. The guest has no Chromium, so the server asks the shell (`LH_DEMO_BRIDGE_URL`) to run a demo in a fresh system WebView and report console errors, uncaught exceptions, failed requests and the probe's value (`src/agent/subagents/headless-bridge.ts` is the client). SVG and PDF rendering stay in Node.
- `SpeechBridge.kt`: dictation. The page talks to the system `SpeechRecognizer` (on-device only) through the same `window.lhAndroid` channel as the native ink layer, with `speech …` lines (`src/core/speech-bridge.ts` is the page's half).
- `Logic.kt`: everything testable without a device (flow decisions, release asset names and versions, login output parsing, server environment, URLs, token, back order, insets, redaction); `src/test/` covers it.
- `MainActivity.kt`: the WebView, the status screens (setup progress, Claude sign-in, a server that does not start), permissions, file chooser, blob downloads, edge-to-edge insets, the native ink layer.
- Back: the shell dispatches `lh:back` to the page (`components/back-layers.ts`), then goes back in page history, then exits.

## Build (Windows, macOS, Linux)

JDK 17+ (21 is what was used), the Android SDK with platform 37 and build-tools 37 (`ANDROID_HOME`, or `sdk.dir` in `local.properties`), Python 3 for the proot download, then:

```sh
cd android/app
python scripts/fetch-proot.py         # once: proot, its loader, libtalloc, libandroid-shmem -> src/main/jniLibs (git-ignored)
./gradlew test assembleDebug          # unit tests, then build/outputs/apk/debug/*.apk
adb install -r build/outputs/apk/debug/learnharness-android-debug.apk
```

`adb` over Wi-Fi works too (Developer options → Wireless debugging → `adb pair`, `adb connect`). Debug-signed APK only; there is no release signing yet (it needs the owner's keystore). The GPL source offer for proot is in [../NOTICE.md](../NOTICE.md) and still needs the owner's wording.

## Testing a build without the releases

Serve the release assets from the PC and point the first run at it (debug builds):

```sh
# a directory holding learnharness-rootfs-linux-arm64.tar.gz(+.sha256), rootfs-version.txt,
# learnharness-server-linux-arm64.tar.zst(+.sha256), version.txt
python -m http.server 8099 --bind 127.0.0.1
adb reverse tcp:8099 tcp:8099
adb shell am start -n dev.learnharness.android/.MainActivity --ez lh.dev false --es lh.release http://127.0.0.1:8099
```

`--es lh.release ""` goes back to the real releases.

## Dev mode (debug builds)

The status screen has a **Dev server (PC)** switch. On: no pairing, the WebView loads `http://127.0.0.1:3000`, which is the PC's server through

```sh
adb reverse tcp:3000 tcp:3000
```

Run the PC side bound to `127.0.0.1`, without `LH_ACCESS_TOKEN` (so it has no gate):

```sh
npm run dev -- -H 127.0.0.1
```

The `-H 127.0.0.1` matters. A plain `next dev` answers the shell's `/_next` requests with 403 ("Blocked cross-origin request to Next.js dev resource"): the page's JavaScript never loads. A production build works too: `npm run build`, then `npm run start`.

Stop the app's own server first (close the app and swipe away its notification): it holds the same port. `adb shell am start -n dev.learnharness.android/.MainActivity --ez lh.dev false` turns dev mode off again. Remote debugging is on in debug builds (`chrome://inspect`).
