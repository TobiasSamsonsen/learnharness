# M7 plan: device bring-up (`lh` scripts, server in proot, whisper in Termux)

Status: **awaiting approval** (2026-10-26). Parent: [plan.md](plan.md) §4 and §7 (M7). Inputs: [feasibility.md](feasibility.md) (M0 numbers and gotchas), M4 (`LH_WHISPER_URL_*`), M6 (token mode, health, knobs, arm64 tarball). Track B: runs on the owner's Pixel 7 Pro, no APK yet; the app is used in Android Chrome through the pairing URL.

## Owner decisions (this session)

| Topic | Decision |
|---|---|
| Tarball | The arm64 workflow also publishes a rolling pre-release `android-latest` on the fork (replaced on every run: manual dispatch or `v*` tag). `lh update` downloads it with plain curl, no login |
| Getting `lh` onto a phone | One curl line fetches the single file `android/termux/lh` from `main` into `$PREFIX/bin`; `lh install` does the rest; `lh update` also refreshes `lh` itself. No git clone on the phone |
| Pairing | Persistent token (`~/.lh/token`, mode 600), made once. `lh pair` prints `http://127.0.0.1:3000/?lh_token=…` as a link to long-press in Termux → Open URL; `lh pair --rotate` makes a new token and restarts. No Termux:API app |
| Whisper | `lh start` runs both language servers (nb and en, 4 threads each, loopback) and exports `LH_WHISPER_URL_NB` / `_EN`. `STT_LANGS="nb en"` in `~/.lh/config` drops one to save RAM |
| Claude login | `lh login`: runs `claude auth login` under a pty in the guest, prints the URL as a link, asks for the code at a normal shell prompt and feeds it to `claude` (the M0 workaround). `lh install` ends by running it |

## Applied as the plan says (no choice left; shout if you disagree)

- **Commands:** `lh install | login | start | stop | restart | status | update | pair [--rotate] | logs [server|nb|en] | version`. One bash file, no dependencies beyond Termux packages.
- **Layout in Termux** (`~/.lh/`): `token`, `config` (shell-sourced: `PORT=3000`, `STT_LANGS="nb en"`, `WHISPER_THREADS=4`, `MAX_SESSIONS=2`), `run/` (PID files), `logs/`, `models/` (GGML files), `src/whisper.cpp` (pinned commit `231638a`, built on the phone with `cmake -DCMAKE_BUILD_TYPE=Release`, clang, targets `whisper-server`).
- **Layout in the guest** (proot-distro `ubuntu:24.04`): `/opt/node` (Node 26.12.1 tarball, `libatomic1`), `claude` (npm global), `/opt/lh/server` (the tarball), `/root/lh-data` (`LH_DATA_DIR`), `/root/.lh/auth.json` (`LH_AUTH_FILE`), `/root/.lh/token` (copied from Termux, mode 600, read by the guest start script so the token is never on a command line), Playwright's arm64 Chromium (`PLAYWRIGHT_BROWSERS_PATH`, `CHROME_PATH` → its `chrome`), `python3`, `zstd`.
- **Server env** (guest start script): `NODE_ENV=production PORT HOSTNAME=127.0.0.1 LH_ACCESS_TOKEN LH_DATA_DIR LH_AUTH_FILE LH_UPSTREAM_CHECK=0 LH_CLAUDE_CODE_MAX_SESSIONS=2 LH_STT_ENGINE=whispercpp LH_STT_DEVICE=cpu LH_WHISPER_URL_NB=http://127.0.0.1:8178 LH_WHISPER_URL_EN=http://127.0.0.1:8179 CHROME_PATH LH_PYTHON=python3`, `PATH` with `/opt/node/bin`. proot shares the Android network namespace, so the guest reaches Termux's whisper servers on loopback.
- **Lifecycle:** `lh start` takes `termux-wake-lock`, starts whisper-server (native, detached, PID file), then `proot-distro login ubuntu -- /opt/lh/start.sh` detached with `setsid nohup`, whose script stays in the foreground (M0 gotcha: proot kills background children when its shell exits). `lh stop` kills by PID file (never `pkill -f`), releases the wake lock, and checks `/api/health` is gone. `lh start` waits for `/api/health` (60 s) and prints the pairing link.
- **Whisper models:** downloaded by `lh install` with `curl -C -` into `~/.lh/models/` from the M4 repos (`NbAiLab/nb-whisper-small` `ggml-model-q5_0.bin`, `ggerganov/whisper.cpp` `ggml-small.en-q5_1.bin`), sha-less but size-checked.
- **`lh update`:** `curl` the asset plus its `.sha256`, verify, extract to `/opt/lh/server.new`, swap, restart if it was running; refresh `lh` from `main`. Data and token are never touched. `lh status`: versions, PIDs, `/api/health`, RSS of the server, `claude` and whisper processes, `MemAvailable`.
- **Workflow change** (`.github/workflows/android-server.yml`): after the pack step, `permissions: contents: write`, then `gh release` creates `android-latest` as a pre-release if missing and uploads `learnharness-server-linux-arm64.tar.zst`, its `.sha256` and a `version.txt` (package version + commit) with `--clobber`. Asset names are fixed. The 7-day artifact upload stays.
- **Docs:** `android/termux/README.md` (the paste block, battery → Unrestricted, the Android 14+ "Disable child process restrictions" toggle and the `adb`/`device_config` route for 12-13, the M0 gotchas that matter to a user: mirror 429, `ip` blocked, Chrome secure-context for the mic); `docs/android/STATUS.md` gets an M0 entry (it is still missing) and an M7 entry, and its stale "free to pick up" lines are corrected.

## Tests (on the PC)

- `bash -n` and `shellcheck` (CI has it) on `android/termux/lh` and the embedded guest scripts.
- `tests/android-lh.test.ts`: runs `lh` under a temp `HOME` with stub `proot-distro`, `termux-wake-lock`, `curl`, `cmake` on `PATH`: `version`, `pair` (link shape, token created once, mode 600, `--rotate` changes it), `config` parsing (`STT_LANGS`), `stop` with a stale PID file, `update` refusing a bad sha256. It skips on a machine without bash.
- The generated guest `start.sh` is checked to contain every env var above and never the token value.

## Verified on the phone (by me, over the existing ssh)

After removing the M0 guest and `~/bench` (the spike's state; the owner OKs this by approving the plan), a **fresh** run: curl `lh` → `lh install` → `lh login` (owner pastes the code) → `lh start` → `curl` the health endpoint, pair with the cookie from the link, a chat turn through the real `claude` (haiku-5-5) with the SSE reply, a dictation request to `/api/stt/local` with the M4 nb clip against both whisper servers (text equals M0's), a demo-runtime Chromium launch through the server, `lh stop` → `lh start` (state kept), `lh update` against the published release. Numbers recorded: install wall time, server idle and chat-time RSS, `MemAvailable` before/after, time to first byte of a lesson reply.

## Left to the owner (needs hands on the phone, the plan's Track B checklist)

Open the pairing link in Android Chrome; a full lesson; a quiz answered by sketch (web canvas, finger or pen); a practice problem with sketch + voice (mic permission for `127.0.0.1`); a demo; a restart that survives; a screen-off turn with the wake lock. I will write what each step needs to show and record the results you report.

## Not in M7

The APK/shell (M8), `RUN_COMMAND` start from an app, Termux:Boot autostart (M8 open item), the performance/lifecycle work (M11: live continuation, chat-list parse cost, killer runbook beyond the README note), TLS, any server code change (none expected; if the device shows one, I stop and ask).

## Risks to watch

- The first CI run of the new release step (needs `contents: write` on the fork's Actions; if the repo setting forbids it, I stop and ask).
- whisper.cpp compile time on the phone and thermals (M0: the build ran fine in the background while other work happened).
- The Android 17 child-process restriction: the README states what to check; if the server is killed under load we hit it in the screen-off test.
