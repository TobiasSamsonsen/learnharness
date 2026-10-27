# learnharness on Android (Termux)

Runs the server, `claude`, Python and headless Chromium on the phone or tablet, in one proot Ubuntu; `whisper-server` runs natively in Termux for dictation. You use the app in Android Chrome. Background: [docs/android/plan.md](../../docs/android/plan.md); what was measured on a real phone: [docs/android/feasibility.md](../../docs/android/feasibility.md).

You need an arm64 Android device (tested on a Pixel 7 Pro, Android 17), about 6 GB free storage, and (strongly) 12 GB RAM. Expect 2-3 GB free RAM to be the limit, so close heavy apps while you study.

## Set up

1. Install **Termux from F-Droid or its GitHub releases** (the Play Store build is abandoned). Open it once.
2. Android Settings → Apps → Termux → Battery → **Unrestricted**.
3. Termux has a rate-limited default mirror. If `pkg update` says 429 or "not signed", switch to the official one:

   ```sh
   echo 'deb https://packages-cf.termux.dev/apt/termux-main stable main' > $PREFIX/etc/apt/sources.list
   pkg update -y && pkg upgrade -y
   ```

4. Get `lh` and run the installer (about 15 minutes, mostly compiling whisper.cpp):

   ```sh
   pkg install -y curl
   curl -fsSL https://raw.githubusercontent.com/TobiasSamsonsen/learnharness/main/android/termux/lh -o $PREFIX/bin/lh
   chmod +x $PREFIX/bin/lh
   lh install
   ```

   `lh install` installs the packages, the Ubuntu guest (Node 26, `claude`, Playwright's arm64 Chromium), builds whisper.cpp, downloads the two small whisper models (365 MB) and the server, then asks you to sign in to Claude. Re-running it is safe; it skips what is done.
5. `lh start`. It prints a link; **long-press it → Open URL**. Chrome opens learnharness and the page sets a pairing cookie. You do this once per token.

   Or use the **Android app** (`android/app`, see its README): it starts the server and pairs by itself. That needs one more Termux setting: `mkdir -p ~/.termux && echo 'allow-external-apps=true' >> ~/.termux/termux.properties && termux-reload-settings`, and the app's "Run commands in Termux environment" permission.

## Commands

| | |
|---|---|
| `lh start` / `stop` / `restart` | Start or stop the server and the whisper servers, and hold or release the wake lock |
| `lh status` | Processes, their memory, `MemAvailable`, `/api/health` |
| `lh pair` | Print the pairing link again. `lh pair --rotate` makes a new token (old cookies stop working) and restarts. `lh pair --print-token` prints the bare token (the Android app reads it this way) |
| `lh login` | Sign in to Claude again (`--force` to sign in as someone else) |
| `lh update` | Refresh `lh` itself and the server from the `android-latest` release; restarts if it was running. Your data and token are not touched |
| `lh logs [server\|nb\|en] [-f]` | Show or follow a log |

Settings live in `~/.lh/config` (plain shell, edit then `lh restart`):

```sh
PORT=3000
STT_LANGS="nb en"      # whisper-server languages available
STT_EAGER=""           # the ones `lh start` starts at once (empty = the first of STT_LANGS); the others start on first use
                       # (the server asks through a request file in the guest) and stop after WHISPER_IDLE_MIN idle minutes
WHISPER_IDLE_MIN=10    # each running language costs 300-700 MB (the GPU build about 700), so only the one you use is kept up
WHISPER_THREADS=4      # 4 was the fastest on a Pixel 7 Pro; 8 is not faster
WHISPER_GPU=auto       # auto: the Vulkan GPU build if it works (checked at start), else CPU; on: require it; off: CPU
WHISPER_ARGS="-nf -ac 640"  # whisper-server flags: no re-decode fallback, a short audio window
MAX_SESSIONS=2         # live claude processes the app keeps
```

Where things are: Termux `~/.lh/` (token, config, logs, whisper source and models); the guest's files are under `$PREFIX/var/lib/proot-distro/containers/ubuntu/rootfs/`: your data in `root/lh-data`, the server in `opt/lh/server`.

## Keep it alive

- **Phantom process killer.** Android 12+ may kill Termux's background processes (the server, `claude`, Chromium). On **Android 14+**: Settings → System → Developer options → **Disable child process restrictions**. On Android 12-13 run once from a PC with the phone connected (from [agnostic-apollo's notes](https://github.com/agnostic-apollo/Android-Docs/blob/master/en/docs/apps/processes/phantom-cached-and-empty-processes.md); not tested here): `adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent; /system/bin/device_config put activity_manager max_phantom_processes 2147483647; settings put global settings_enable_monitor_phantom_procs false"`.
- Keep the **wake lock** (`lh start` takes it; the Termux notification shows it) and the Termux battery setting on Unrestricted. Samsung: add Termux to "Never sleeping apps".
- Dictation needs the mic in Chrome: allow it for `127.0.0.1` when asked. Chrome treats `127.0.0.1` as a secure context, so no certificate is needed.

## Troubleshooting

- `ip` fails with "Cannot bind netlink socket": Android blocks it for apps. You rarely need it; read the IP in Settings → Wi-Fi if you ssh in.
- Slow dictation: the whisper servers run with `-nf -ac 640`, the app cuts live pieces at 3-8 s, and `lh install` builds a Vulkan GPU version that `lh start` uses when it passes a self-test (`lh status` says `gpu` or `cpu` per language). On a Pixel 7 Pro that is about 2.7-3x real time instead of 0.8x. The GPU roughly doubles each whisper server's memory (about 700 MB instead of 300-400 MB): set `WHISPER_GPU=off` or drop a language from `STT_LANGS` if memory is tight. While Termux is in the background Android only lets it use cores 0-5 (not the fastest two), so numbers taken with Termux in front are too good. Details: [docs/android/stt-tuning.md](../../docs/android/stt-tuning.md).
- The page says 403 or "pair": run `lh pair` and open the link again (the cookie is per browser).
- The server does not come up: `lh logs`, and `lh status` for memory. `claude` errors about login: `lh login`.
