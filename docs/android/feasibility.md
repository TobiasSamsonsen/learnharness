# M0 feasibility spike: Pixel 7 Pro, Termux + proot Ubuntu (2026-10-26)

Plan: [plan.md](plan.md) M0. No repo code changed; this file is the only output. Driven from the PC over SSH into Termux (`sshd` on port 8022), one throwaway key.

## Device

| | |
|---|---|
| Phone | Pixel 7 Pro (GS201 / Tensor G2), Android 17 (SDK 37), kernel 6.12.81 |
| CPU | 8 cores: cpu0-3 Cortex-A55 (1.8 GHz), cpu4-5 A78 (2.35 GHz), cpu6-7 X1 (2.85 GHz). Features: NEON, dotprod, fp16. **No i8mm, no bf16** |
| RAM | 11.2 GB total, 5.6 GB swap (zram). **MemAvailable was only 2.3-3.3 GB** with the phone's usual apps open |
| Storage | 110 GB, 20 GB free |
| Termux | F-Droid/GitHub build, `$PREFIX=/data/data/com.termux/files/usr`, user `u0_a242` |
| Guest | proot-distro 5.10.3, `ubuntu:24.04` (24.04.5 LTS, aarch64) |

Not checked: the "Disable child process restrictions" developer toggle (Android 14+) and any screen-off / phantom-process-killer run. Nothing here ran with the screen off.

## Verdict per check

| # | Check | Result |
|---|---|---|
| 1 | Termux → proot Ubuntu → Node 26 | **Go.** Node 26.12.1 (nodejs.org linux-arm64 tarball) runs after `apt install libatomic1` |
| 2 | `claude` login + stream-json round trip with an image | **Go.** Claude Code 2.1.310, subscription login, image described correctly. Login needs a workaround (below) |
| 3 | Playwright Chromium headless | **Go.** Chrome for Testing 156.0.8078.4 arm64, launches with the app's own flags, canvas works |
| 4 | whisper.cpp native build | **Go.** Builds in Termux with clang; NEON, DOTPROD, OpenMP, REPACK on |
| 5 | whisper-server speed | **Marginal, see below.** nb-small about 1.0-1.7x real time, en-small 1.5-2.5x, medium models 0.4x (no-go). Quality equals the PC |

## 2. `claude` (numbers)

- `npm i -g @anthropic-ai/claude-code`: 17 s, 2 packages.
- Round trip: the provider's real flags (`-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --no-session-persistence --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands --model claude-haiku-5-5`), one user message with a 240x240 PNG (a black right triangle) and "Describe this image in one sentence." Reply: right triangle, right angle bottom-left, vertical edge on the left. First byte 2.4 s, whole turn 5.2 s, 2,777 tokens cache-created, $0.0006.
- Largest process in the tree: 213 MB RSS (GNU `time -v`; the whole-tree sum was not measured).

**Login gotcha.** `claude auth login` inside the phone's Termux terminal showed "Paste code here if prompted >" and took no input at all (typing and long-press paste both dead; not tried over `ssh -t` from a PC terminal). It worked by running it under `script -qfc` with a FIFO as stdin, then writing the code plus `\r` into the FIFO. That session must stay in the foreground of the proot shell (`wait`), or proot kills the background `claude` when the shell exits. The `lh pair`/login step in M7 has to handle this, or use another route (e.g. `claude setup-token`, untested).

**Not exercised:** the MCP image-result path (a held tool call answered with an image through the stdio MCP stub and the loopback bridge). The round trip above sends the image as a user-message block, the `userContent` path. The stub and bridge under proot are an M7 check, or a small `--mcp-config` server that returns an image can be run on the device first.

## 3. Chromium

- `npm i playwright puppeteer-core@25.8.0` (the repo's puppeteer-core), `playwright install-deps chromium` (pulls xvfb and libs through apt), `playwright install chromium`: 67 s. Binary: `$PLAYWRIGHT_BROWSERS_PATH/chromium-1248/chrome-linux-arm64/chrome` (use that as `CHROME_PATH`).
- Launch with the exact flags of `src/agent/subagents/headless.ts:268` (`--disable-gpu --no-sandbox --disable-dev-shm-usage`), no extra flag needed under proot: launched in 2.3 s, `setContent` with canvas + SVG, a canvas pixel read back correctly (0,0,255,255), screenshot written, 3.1 s end to end. Largest process 207 MB RSS (tree total not measured).

## 5. whisper-server (numbers)

Setup: whisper.cpp `231638a` built natively in Termux (`cmake -DCMAKE_BUILD_TYPE=Release`, clang, OpenMP). One `whisper-server` per run on loopback; `curl -F file= -F language= -F temperature=0 -F response_format=json /inference`; one untimed warm-up, then the timed requests. The M4 "tech" clips (nb 50.2 s, en 58.5 s), vocabulary prompt off. Speed = clip seconds / wall seconds, so 1.0 is real time. Model load 0.3-2 s. Peak server RSS (`VmHWM`): nb-small 408-434 MB, en-small 393 MB, nb-medium 896 MB.

**Run 1** (all 8 cores allowed, 2 timed runs per config, phone already warm from the builds):

| Model | Threads | Run 1 | Run 2 |
|---|---|---|---|
| nb-small q5_0 | 2 | 1.09x | 1.01x |
| nb-small q5_0 | 4 | 0.88x | 0.66x |
| nb-small q5_0 | 8 | 1.00x | 0.69x |
| nb-medium q5_0 | 2 | 0.36x | 0.40x |
| nb-medium q5_0 | 4 | 0.43x | 0.41x |
| nb-medium q5_0 | 8 | 0.40x | 0.41x |
| en-small q5_1 | 2 | 1.26x | 1.29x |
| en-small q5_1 | 4 | 2.03x | 1.89x |
| en-small q5_1 | 8 | 1.50x | 1.50x |

**Run 2** (a 30 s pause between configs, 3 timed runs; `taskset` = the cores the server may use):

| Model | Cores | Threads | Run 1 | Run 2 | Run 3 |
|---|---|---|---|---|---|
| nb-small q5_0 | all | 4 | 1.73x | 1.25x | 1.19x |
| nb-small q5_0 | 6-7 (X1) | 2 | 0.88x | 0.91x | 0.74x |
| nb-small q5_0 | 4-7 (big) | 4 | 1.64x | 1.21x | 1.19x |
| nb-small q5_0 | 4-7 | 3 | 0.95x | 0.95x | 0.93x |
| en-small q5_1 | 4-7 | 4 | 2.52x | 1.91x | 1.90x |
| en-small q5_1 | 6-7 | 2 | 1.47x | 1.45x | 1.45x |

**Quality** (WER against the reading script, same normalisation and `cleanWhisperText` as the M4 bench): en-small 1.7% (4 threads) and 2.5% (2 and 8); nb-medium 20.2-21.3%; nb-small 14.6% (2 and 4 threads) and 21.3% (8). The PC run (tech clip, no prompt) had en-small 1.7%, nb-medium 21.3%, nb-small 15.7% (4) / 18.0% (8); the Norwegian small spread is the float-ordering noise M4 already documented. The phone's transcripts are within that run-to-run noise of the PC's, not systematically worse.

**What the numbers say**
- **The phone is roughly 5-7x slower than the PC on the same clip** (PC, 4 threads, tech clip, no prompt: nb-small 8.6x, en-small 12.1x, from `results.json`; phone 1.2-1.7x and 1.9-2.5x).
- **Throttling is real.** The same config falls from 1.7x to 1.2x within three 50 s requests, and the first matrix (phone warm) was lower still. Treat any single figure as ±40%. Live dictation is bursty (8-25 s pieces with pauses), so the steady state sits between the first-request and the third-request numbers.
- **4 threads is the setting.** Pinning to the big cores (`taskset -c 4-7`) did not beat leaving it unpinned; 8 threads was not faster (OpenMP waits on the A55 stragglers); 2 X1 cores alone was slower; 3 threads was oddly poor. Nothing to gain from pinning in `lh`.
- **Small models only.** Medium runs at 0.4x, far under real time.
- **Norwegian is slower than English** with the same model size (1.2-1.7x vs 1.9-2.5x at 4 threads), and the transcripts have no decode loops, so this is the model, not a fault.
- **Consequence for live dictation:** a 25 s piece takes roughly 15-25 s to transcribe in Norwegian, so while the learner keeps talking, pieces queue behind each other. It is usable, not comfortable. This is the number to weigh when buying the tablet: a current flagship (X925-class, with i8mm) should do better than this 2022 SoC, but nothing measured here proves it.

## Gotchas for M7 (`lh` scripts)

1. **Termux mirror.** The default mirror (`mirror.textcord.xyz`) answered 429, which apt reports as "repository is not signed". Use `echo 'deb https://packages-cf.termux.dev/apt/termux-main stable main' > $PREFIX/etc/apt/sources.list` (the `packages.termux.dev` host is the second choice).
2. **`ip` is blocked** (netlink "Permission denied") on this Android; read the IP from Settings, or `ifconfig` from `net-tools`.
3. **SSH from Windows OpenSSH 9.5 to Termux sshd 10.6** corrupts the stream after login ("Bad packet length"). Cause: the post-quantum `sntrup761x25519-sha512` key exchange. Fix on the client: `-o KexAlgorithms=curve25519-sha256`. Only relevant to this spike's remote control.
4. **proot-distro 5.10.3 rootfs** is `$PREFIX/var/lib/proot-distro/containers/ubuntu/rootfs` (not `installed-rootfs`). `proot-distro install ubuntu:24.04`.
5. **Node 26 in the guest needs `libatomic1`.**
6. **A proot login shell that exits kills its background children.** Long-lived guest services must run in the foreground of one `proot-distro login … -- <script>` (the script ends in `wait`).
7. **`pkill -f <pattern>` kills your own SSH command** if the pattern is in its text; `lh stop` should use PID files.
8. Termux:API and the notification/wake-lock behaviour were not exercised; `termux-wake-lock` was set once for the whole session and the screen stayed on.

## Open for M7

- Screen-off survival and the phantom-process killer on Android 17 (is the child-process toggle still where Android 14+ had it?).
- Whole-tree memory with `claude` + Next + whisper-server + Chromium + the WebView at once, against the 2.3-3.3 GB that was free.
- The login flow for `lh pair`.
- Whether to keep Norwegian on small, or add a smaller/faster option, once the real tablet's numbers exist.
