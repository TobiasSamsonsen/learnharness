# M11 plan (DRAFT): device performance and lifecycle

Status: **decisions made by the owner 2026-10-27 (see "Owner decisions"); implementation in progress on `feat/m11-prep`**. Parent: [plan.md](plan.md) §4 and §7 (M11: "live continuation for practice submissions (no respawn), chat-list parse cost, wake-lock/killer runbook, RAM budget; done when: before/after timings on the device"). Written by Claude while the owner was away, from a read-only audit of the code and a read-only snapshot of the phone. Nothing is built. Per AGENTS.md "No guessing", the choices are under "Questions for the owner".

## Owner decisions (2026-10-27)

| # | Decision |
|---|---|
| Q1 | **Keep the respawn after a pose and make it cheaper.** No change to the turn model; revisit live continuation only if the measured replay is still slow on the phone |
| Q2 | **Elide concluded problems from the replay**: everything between a problem's pose and its (non-refused) `conclude` result is replaced by one short omitted-note once a later problem has been posed; the active problem stays in full. Sketch page cap stays 20 |
| Q3 | **Keep 40 min idle and 2 sessions; add an env knob** `LH_CLAUDE_IDLE_MIN` |
| Q4 | **In-memory `listChats` cache** (done, see below) |
| Q5 | **Start only the language in use**: `lh start` starts the default language's whisper-server; the other starts on first use through a supervisor loop in Termux that watches request files the server touches inside the guest, and stops after **10 idle minutes** |
| Q6 | **Runbook only**; no foreground service in the app for now |

Applied as the plan says (small names; shout if you disagree): the server knob is `LH_CLAUDE_IDLE_MIN` (minutes, default 40, bad values fall back); in `~/.lh/config`, `STT_LANGS` stays "the languages available", the new `STT_EAGER` lists those started with `lh start` (default: the first of `STT_LANGS`), `WHISPER_IDLE_MIN=10`; the request files live in the guest at `/root/.lh/want/<lang>` (Termux reads them through the rootfs path).

## Implemented on `feat/m11-prep` (2026-10-27)

| Decision | What was built | Tests |
|---|---|---|
| Q2 elide concluded problems | `elidedProblems()` + the renderer in `src/agent/claude-code.ts`: a problem concluded (non-refused `conclude`) before a later pose is replaced by one `<omitted>` note in the respawn replay; the active problem stays in full; live sessions and the fed fingerprints are untouched | `tests/claude-code-replay-elision.test.ts` (5) |
| Q3 idle knob | `LH_CLAUDE_IDLE_MIN` (`parseIdleMs`, default 40) | `tests/claude-code.test.ts` |
| Q4 cache | `listChats` summary cache (above) | `tests/chat-list-cache.test.ts` (5) |
| Q5 on-demand whisper | server: `LH_WHISPER_WANT_DIR`, a request touches `<dir>/<lang>` and waits up to 60 s for the language to come up (`src/server/stt/whispercpp.ts`); `lh` 0.4.0: `STT_EAGER` (default the first of `STT_LANGS`), `WHISPER_IDLE_MIN` (10), a supervisor loop (`lh _supervise`, `--once` for tests) started by `lh start` and stopped by `lh stop`, `lh status` shows `stopped (starts when asked for)`; README config block updated | `tests/stt-whispercpp.test.ts` (+2), `tests/android-lh.test.ts` (+3, 3 adjusted for the new default) |

Behaviour change to know about: with an existing config of `STT_LANGS="nb en"` and no `STT_EAGER`, `lh start` now starts only `nb`; English dictation starts its server on the first request (a few seconds' wait, then normal). Set `STT_EAGER="nb en"` to get the old behaviour. `shellcheck` could not be run on the PC (the sandbox refused to run a downloaded binary); the CI workflow's first step runs it on `android/termux/lh`.

Not built: Q1 (nothing to build, respawn stays), Q6 (runbook only), the phone timings (need the phone), the `pendingProblem` question.

## Findings

### 1. Why the first submission after a `problem` pose respawns `claude` (verified in the code)

- A call continues live only when the session exists, its state is `awaiting-tools` or `idle`, the fed prefix matches, and `continuation()` accepts the delta (`src/agent/claude-code.ts` L1179-1206, `continuation` L695-710). Otherwise the old process is killed and the whole transcript is replayed (`renderClaudeCodeRequest`, L238-281).
- The pose is a tool call that **terminates the turn** (`problemResult()`, `src/agent/tool-execute.ts` L240-250, `terminate: true`). The process is left `awaiting-tools` with the `problem` call still held open (`settle` L955-984; the held call is never answered).
- The learner's next submission is a `practice-thinking` **marker**, which `toLlmMessages` turns into a `user` message (by design: "the learner's next thinking submission is the next turn"). The delta is therefore `[toolResult(problem), user(thinking)]`. In `awaiting-tools`, `continuation()` accepts only tool results, so a trailing user message returns null; the test pins exactly this case (`tests/claude-code.test.ts` L319, "a message after the results: start fresh").
- Prefix and fingerprints are **not** the blocker; the state machine is. Later submissions on the same problem do continue live (idle + user).
- Replay cost grows with problems × sketch pages (cap `SKETCH_MAX_REQUEST_PAGES` = 20; sketches already elide once confirmed and closed).
- The idle sweeper kills a non-streaming session after 40 minutes (`IDLE_MS`, L607, no env knob); a session waiting longer respawns anyway.

### 2. `listChats` (read from the code; local numbers, not the phone's)

- `src/store/chats.ts` L83-128: reads and `JSON.parse`s **every** chat file, synchronously, on every call; no cache, no mtime check. `writeChat` rewrites the whole file on every persist, and `turns`/`extractions` arrays grow inside the record and are parsed then discarded by the list.
- Callers: `GET /api/chats` (the sidebar: at least two calls per turn, plus each event it listens to, 250 ms debounced), `activityFeed` (on `activity-changed`/`jobs-changed`, which fire often during extraction), `graphCosts` (parses every record **twice**), `courseChats`/`learnChatsBySkill`, `graphSessionIndex`, and `recoverStaleJobs` (throttled to 30 s).
- **Measured (PC, `npx tsx scripts/bench-list-chats.ts`, synthetic 20-message chats of ~18 KB each, a throw-away data dir):** 10 chats 2.3 ms, 50 chats 10.8 ms, 150 chats 36.8 ms, 400 chats 96 ms per call, linear (about 0.24 ms per chat). The phone is slower (proot, a slower core); a factor of 3-6 is plausible but **not measured**, which would put 150 chats at roughly 110-220 ms per call, several calls per turn, on the thread that also streams the reply.
- Dev data: 160 files, 494 KB, largest 19 KB. Sketches are not in the record (only `SketchRef`), so they do not inflate the list. The cost is O(total bytes of all chats) per call, and it blocks the Node event loop, which is shared with SSE. Estimate, not measured: 100 chats × 20 KB = 2 MB of parse per call, a few times slower under proot.

### 3. RAM and lifecycle on the Pixel 7 Pro

Earlier numbers (STATUS.md): server group 159 MB idle / ~430 MB with a live `claude`, each live `claude` ~240 MB, whisper 265-279 MB per server on CPU and ~700 MB per server with the Vulkan build, `MemAvailable` 4.36 GB at start down to ~1.8 GB after a 47-minute lesson.

Snapshot taken 2026-10-27 11:5x while the phone sat idle with the server running (read-only, over adb): **MemTotal 11.7 GB, `MemAvailable` 1.69 GB, swap 5.6 GB of which only 5 MB free**; `whisper-server` ×2 at 647 MB and 594 MB RSS (the GPU build), `com.termux` 128 MB, Chrome 229 MB, plus the other apps. So whisper is now the largest single consumer, and the phone is already out of swap before a lesson starts. Not measured yet: the Node server and `claude` inside proot (they do not show by name in `ps`), screen-off survival, the phantom-process killer in practice, respawn replay timing on the device.

Wake lock: `lh start` takes `termux-wake-lock` (Termux notification); nothing in the app holds one.

## Sub-tasks (each with the decision it needs)

| # | Sub-task | Files | Needs the owner |
|---|---|---|---|
| 1 | Live continuation after a pose | `claude-code.ts` (`continuation`, `settle`, `matchHeld`), `tool-execute.ts` (`problemResult`), `native-messages.ts`; tests `claude-code.test.ts` L313-326, `claude-code-live.test.ts` | **Yes, Q1** |
| 2 | Cheaper replay (fewer sketch pages, elide old problems) | `native-messages.ts`, `core/sketch.ts` | **Yes, Q2** |
| 3 | Idle timeout and session cap for the phone | `claude-code.ts` L596-607, `android/termux/lh` (`MAX_SESSIONS`) | **Yes, Q3** |
| 4 | `listChats` cost | `store/chats.ts`, callers in `server/*` | **Yes, Q4** (the fix to `graphCosts`/`courseChats` parsing twice needs no decision) |
| 5 | Fewer list calls | `sidebar.tsx`, `activity-dock.tsx` | No (engineering) |
| 6 | Whisper RAM against speed | `android/termux/lh` (`STT_LANGS`, `WHISPER_GPU`) | **Yes, Q5** |
| 7 | Lifecycle: wake lock, killer, screen-off | `lh`, README, (app) | **Yes, Q6** |
| 8 | Before/after timings on the device | `scripts/`, the phone | Needs the owner's phone for some |
| 9 | Doc drift: `plan.md` cites old line numbers (`claude-code.ts` L512-537/L595-597 and `continuation()` L656-671 are now L513-538, L596-607 and L695-710) | `plan.md` | No (fixed with this draft) |

## Questions for the owner (nothing below is decided)

| # | Question | Options (my lean) |
|---|---|---|
| Q1 | How should a submission reach a process that still holds an open `problem` call? | (a) answer the held `problem` call with the learner's submission text as its result, so the process and the record agree (needs a record/replay rendering that matches, or fingerprints diverge); (b) keep the respawn per problem and only make it cheaper (Q2); (c) stop the pose from terminating its call (changes "the turn ends here"). **Lean (b) first:** it needs no change to the turn model; revisit (a) only if the measured replay is slow on the phone |
| Q2 | How many sketch pages may a replay carry, and are old problems elided from it? | Elide everything before the active problem once concluded; cap 6 pages. Measure first (task 8) |
| Q3 | Idle timeout on the phone (40 min today) and the session cap (2)? | Keep 40 min and 2; add `LH_CLAUDE_IDLE_MIN` only if you want it tunable |
| Q4 | `listChats`: (a) in-memory cache keyed on mtime and size (no format change), (b) a persisted summary index (new file and migration), (c) move `turns`/`extractions`/`tree` out of the chat file? | **Decided by the owner (2026-10-27): (a).** Built on `feat/m11-prep`: a per-chat summary reused while mtime and size are unchanged; our own writes and deletes drop the entry; callers get copies. Measured on the PC (`scripts/bench-list-chats.ts`): 150 chats 36.8 -> 3.0 ms, 400 chats 96 -> 8 ms per call (what remains is one `stat` per file). 5 tests in `tests/chat-list-cache.test.ts`; full suite 2527 tests, only the 10 known Windows failures. `graphCosts` still parses each record once in full (it needs the `extractions` the summary drops), no longer twice. Phone timings not measured yet |
| Q5 | Whisper on the phone: keep the GPU build for both languages (~1.2 GB together, ~3× real time), or CPU (~550 MB, slower), or drop one language (`STT_LANGS="nb"`)? Today's snapshot shows swap exhausted | Drop the language you do not use in a given lesson (`STT_LANGS`); that is a config change you can make today with no code |
| Q6 | A foreground service or wake lock inside the app, or a runbook only (battery Unrestricted, the Android 14+ toggle, Termux wake lock)? | Runbook only for now; revisit if the screen-off test fails |

## If approved, how it would be verified

PC: tests for any state-machine change (the `continuation` table, a live-continuation round trip with the fake CLI), a cache test (hit, invalidate on write/delete, mtime change), `graphCosts`/`courseChats` parse-once tests. Device (Claude over adb, a debug probe like M9's): a timed practice lesson before and after (time from submit to first token on the first submission after a pose; `GET /api/chats` latency at 10 / 50 / 150 chats via a generated test data directory, never the owner's); memory snapshots with and without a whisper server. The owner: the screen-off turn and a real session.

## Found while starting (for the owner)

- **`pendingProblem` is never set.** `ChatSummary.pendingProblem` is declared and the sidebar's "Problem waiting" meta reads it (`components/sidebar.tsx` L314), but nothing in `listChats` computes it, so the label never shows. An unchecked type guard in the old code hid it; the cache work kept the behaviour as it was and left a note in `src/store/chats.ts`. Whether and how to compute it (a posed problem with no `conclude`) is a small behaviour change for you to approve.

## Not in M11

A new storage format beyond Q4(b)/(c) if not chosen, a native foreground service unless Q6 says so, TLS, and any change to the teaching prompts.
