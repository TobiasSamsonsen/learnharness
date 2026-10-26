# M4 plan: STT engine seam + whisper.cpp adapter + vocabulary prompt

Status: **awaiting owner approval** (2026-10-26). Parent: [plan.md](plan.md) §6, §7 (M4).

## Owner decisions (this session)

| Topic | Decision |
|---|---|
| Server owner | Both modes. `LH_WHISPER_URL` set → call that server (Android: started natively in Termux). Unset → the Next server spawns `whisper-server` on demand, one per language, kills it after 10 min idle; binary via `LH_WHISPER_BIN` |
| Engine selector | Env var only: `LH_STT_ENGINE=transformers\|whispercpp`, default `transformers`. No Settings field, no settings-schema change |
| Models | Auto-download GGML files from Hugging Face into `<data>/models/stt/ggml/`, progress through the existing `GET /api/stt/local`. Spawn mode only; in URL mode the app downloads nothing |
| Vocabulary inputs | Lesson terms only: active question/problem stem, plan-tree node titles, recent teacher terms (bold spans from the last ~6 teacher messages, then rare words — capitalised / hyphenated / long, not in a small per-language common-word list; math skipped) |
| Bench audio | The owner records a technical-term clip (nb + en, ~60 s each) from a script I write; FLEURS for general WER |
| Bench build | whisper.cpp official CPU build (`whisper-bin-x64.zip`) only; latency is a relative proxy for the tablet |
| Failure | whisper.cpp errors surface as today's failed transcription (recording kept, Retry). No fallback to transformers.js |

## Design

### 1. Engine seam (`src/server/stt-local.ts`)
- `transcribeLocal(language, pcm, { vocabulary? })` and `prepareLocalStt(language)` dispatch on `LH_STT_ENGINE`. The transformers path is untouched.
- New `src/server/stt/whispercpp.ts`: `prepare`, `transcribe`, `status`.
  - Wraps the PCM in a WAV header (pure helper, unit-tested), then multipart `POST <base>/inference` with `{file, prompt, language, temperature:0, response_format:json}`. `language` is sent per request.
  - The existing silence skip (peak < 0.01, < 0.1 s) is kept in front of the call (shared `toFloat` from `pcm.mjs`).
  - Spawn mode: `whisper-server -m <ggml> --host 127.0.0.1 --port <free port> -t <threads>` per language on first use, idle kill after 10 min, readiness polled on the port, `globalThis` state like the worker. Crash → the pending request fails with the process's stderr tail.
  - URL mode: `LH_WHISPER_URL_NB` / `LH_WHISPER_URL_EN`, each optional; a language without a URL returns a clear error (owner). `LH_WHISPER_URL` is not used.
- `LH_WHISPER_THREADS` (default set by the bench).
- `GET /api/stt/local` statuses come from the active engine: `repo` is the GGML file name, `state` derives from the file on disk / the spawned server, `ranOn` is absent.
- Model table for whisper.cpp in `src/core/language.ts` beside `LOCAL_STT_MODELS`. **Provisional**: nb = NbAiLab `nb-whisper-{small,medium,large}` `ggml-model-q5_0.bin`, en = `ggerganov/whisper.cpp` `ggml-large-v3-turbo-q5_0.bin` (or a smaller one). The bench decides; I show you the numbers before fixing the defaults.

### 2. Vocabulary prompt (pure core, `src/core/dictation-vocabulary.ts`)
- `dictationVocabulary(record, language, budget)` → a comma list, ≤ ~150 tokens (Whisper caps prompts at 224), in the lesson language. Inputs as in the decision table; deduped, newest first, truncated to the budget.
- The route takes `?chat=<id>`; `dictation.tsx` passes the chat id it already has (`useDictation({chatId})`). Home / new-session (no chat) send no prompt.
- Cached per chat, keyed by the record's last-message id, in the server.
- Sent only on the whispercpp engine (transformers.js 4.3.1 has no `prompt_ids`).
- Hallucination guard: if the transcript is a contiguous copy of the prompt (or a sub-list of it) and the clip is short/quiet, drop it. Tested.

### 3. Bench (`scripts/bench-stt.mjs`, results `docs/android/stt-bench.md`)
- Same shape as the 2026-10-25 FLEURS run: WER + wall time + real-time factor.
- Matrix: nb small/medium (q5_0) and en candidates × thread counts × {no prompt, vocabulary prompt}; FLEURS for general WER, your recording for the technical-term clip.
- Binaries and models stay outside the repo (under `<data>/models`, git-ignored).
- Output decides: default nb/en models, default thread count, and whether the prompt helps (if it doesn't, it stays off by default).

### 4. Tests
- WAV wrapper, multipart body, `dictationVocabulary` (budget, ordering, math skipped, language), hallucination guard, engine dispatch, spawn lifecycle against a fake `whisper-server` script (`tests/fixtures/`, like the fake `claude`), status mapping.
- `npm run typecheck`, `npm run lint`, `npm test` (10 known Windows failures).
- Docs: README "Local dictation" gets an engine section; `docs/android/STATUS.md` M4 section.

## Order of work
1. Branch `feat/stt-whispercpp` from `main`.
2. WAV + engine seam + adapter + fake-server tests.
3. Vocabulary function + route/`dictation.tsx` plumbing + tests.
4. Download whisper.cpp CPU build + models, smoke-run the real server on Windows.
5. Write the recording script; bench; you review the numbers; set defaults.
6. Docs, STATUS, merge.

## Questions still open
None. (The "Server owner" decision's `LH_WHISPER_URL` is refined to per-language URLs above.)
