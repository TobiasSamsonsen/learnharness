# M7b plan: faster dictation on the phone, and sketch-completeness grading

Status: **approved and implemented** (2026-10-26); see STATUS.md. Follows M7 ([m7-plan.md](m7-plan.md)). Evidence: [stt-tuning.md](stt-tuning.md) (what made the first lesson's dictation wait 30-60 s, and what each fix measured) and the owner's lesson review of the same day.

## Owner decisions (this session)

| Topic | Decision |
|---|---|
| Grading a missing sketch item | If the problem certainly requires something in the sketch and it is missing, the tutor **hints "you forgot something"** (no naming), whether or not it was said aloud, and **does not penalize the score**: once it is added, the problem concludes as `solved`. (Today `solvedWithHints` earns no mastery credit, `solved` advances the box, so this is a real change.) A wrong or missing idea is graded as before |
| Dictation | nb-whisper-small stays; shorter pieces; `-nf -ac 640`; **plus the Vulkan GPU build, with a CPU fallback** |

## Applied as the data says (shout if you disagree)

### A. Dictation (generic code changes, desktop unchanged by default)

- **Piece limits come from the server.** `createSegmenter(sampleRate, limits?)` takes `{minS, maxS}` (defaults stay 8 and 25, so the transformers.js engine and desktop are unchanged). `POST /api/stt/local/prepare` answers `{started, pieceSeconds?: {min, max}}`; the dictation hook applies it before the first cut. With the whisper.cpp engine and `LH_STT_PIECE_S="3-8"` the segmenter cuts at a pause after 3 s and never passes 8 s. The pause rule (0.6 s) is unchanged.
- **Hard cap in the adapter.** `-ac 640` covers 12.8 s of audio; a longer piece would be silently truncated. With `LH_WHISPER_MAX_S=12` (set by `lh`, off by default) `transcribeWhisperCpp` splits any PCM longer than that at its quietest frame (the segmenter's own cut rule, shared pure helper) and joins the texts. A Retry of an old long clip therefore still works.
- **`lh` (`android/termux/lh`)**: whisper-server always gets `-nf -ac 640` (config `WHISPER_ARGS` can override); the guest env gets `LH_WHISPER_MAX_S=12` and `LH_STT_PIECE_S=3-8`.
- **GPU build.** `lh install` also installs `vulkan-headers vulkan-loader-android shaderc spirv-headers glslang`, then builds a second binary (`build-vk`, whisper.cpp pinned commit) after applying one guarded line patch (`std::aligned_alloc` → `posix_memalign`, absent from Termux's libc). A failed GPU build is a warning, not an install failure. `lh start` uses the GPU binary when `WHISPER_GPU` is `auto` (default) or `on`, and falls back to the CPU binary if it exits during start-up or fails a one-request self-test; `WHISPER_GPU=off` forces CPU. `lh status` shows which backend each language runs on.
- **Docs**: `android/termux/README.md` (the new knobs; why Termux in the background only gets cores 0-5), README env section, `docs/android/stt-tuning.md` (already written) linked from `stt-bench.md`.

### B. Tutor (prompt)

New paragraph in `src/agent/prompts/shared/18-sketches.md` (needs your wording approval, see below). Prompt-pin test updated; no code path changes: `conclude` already accepts `solved` after a read.

### C. Tests

- `tests/dictation-live.test.ts`: custom limits cut at the new sizes; defaults unchanged.
- `tests/stt-whispercpp.test.ts` (fake server): a 30 s PCM with `LH_WHISPER_MAX_S=12` becomes 3 requests of at most 12 s, texts joined in order; unset = one request, as today; prepare reports the piece limits only when the env is set.
- `tests/android-lh.test.ts`: whisper-server stub receives `-nf -ac 640`; a GPU binary that exits at start is replaced by the CPU one; `WHISPER_GPU=off` never starts it; the guest env carries the two new variables.
- Prompt test: the sketches fragment contains the completeness rule.
- `npm run typecheck`, `npm run lint`, `npm test` (10 known Windows failures), shellcheck.

## Proposed prompt wording (for your approval)

Added to the end of `18-sketches.md`:

> **A missing listed item is a slip, not a miss.** When the problem's statement plainly requires something in the sketch (a part it lists, a value, a label, a marking) and the sketch lacks it, and you are certain, tell the learner that something from the problem is not on the page yet, **without naming it** (a one-line R0 nudge). It makes no difference whether they said it aloud. If what they said already contains the item, you may point to that ("you said it, now put it on the page"). This costs nothing: when they add it and the rest is right, conclude `solved` with `rung` null and `missClass` null. It covers only what the statement itself requires; a wrong or absent idea is graded as before.

## Verified on the phone (by me)

After `lh update` and a rebuild: both whisper servers run on the GPU (log shows `Vulkan0`); the nb tech clip sent as one 50 s PCM to `/api/stt/local` (so the adapter's chunking runs) returns the same text quality as the piece bench, in about a quarter of the 50 s; `WHISPER_GPU=off` and a deliberately broken GPU binary both end on the CPU; `lh status` reports the backend. The piece limits reach the browser (the prepare response). Then **you** repeat a spoken answer and tell me the wait after you stop.

## Not in M7b

The base model (measured, not chosen); a hallucination guard for tiny trailing pieces (the junk "Hva?-A." on a 0.8 s tail is a known, unfixed issue; dropping short tails could lose a real last word, so it needs its own decision); the Android system recognizer in the M8 shell (untested; Chrome's on-device API is unavailable here); word-level vocabulary tuning for Norwegian maths terms.

## Risks

- Vulkan driver behaviour differs between phones; the self-test and the CPU fallback are the guard, and the tablet you buy needs its own check.
- Building the Vulkan backend adds install time (the shader compile is the slow part) and about 100 MB of disk.
- `-ac 640` shortens Whisper's context: accuracy was equal or better on the two test sets, but they are small (89 and 176 words).
