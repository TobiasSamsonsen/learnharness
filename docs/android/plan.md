# learnharness on Android: handwriting, local dictation, Termux backend

## Context

The owner wants to use this fork on an Android tablet: write math derivations and sketches with a stylus, dictate locally, and have Claude read the handwriting inside the learning loop (questions, practice, mastery). The backend and the `claude` CLI must run on the device, in Termux. This document is the research result and the architecture/migration plan. No code changes until it is approved; each milestone below gets its own short plan and questions when we start it (AGENTS.md "No guessing").

### Decisions already made (owner, this session)

| Topic | Decision |
|---|---|
| Device | Not bought yet. Plan is device-agnostic; hardware advice in §8 |
| Upstream | Stay upstream-friendly: Android code in its own folder, generic changes to the shared app, so upstream merges stay cheap (not expecting upstream to accept PRs) |
| Server home | Everything server-side in **one proot Ubuntu**: Next server, `claude`, Python, headless Chromium. Only `whisper-server` runs natively in Termux |
| arm64 build | GitHub Actions `ubuntu-24.04-arm` runner builds a linux-arm64 standalone tarball (fork is public, so the runner is free) |
| Ink scope | Everywhere. Web canvas first (desktop, browser, WebView); native androidx.ink overlay later as the Android upgrade, behind the same sketch contract |
| Sketch UX | "Open in sketch" button on the **question dock** (all modes) and the **active practice problem**. Opens a full-screen plain canvas with the question in a floating box; submit from the canvas |
| Multiple choice | Options + confidence rail sit inside the floating box; the sketch rides as thinking |
| Practice canvas | Page kept per problem; every submit sends the whole page, with strokes new since the last submit marked; cleared on `conclude` |
| Transcribe-first | Claude transcribes and grades **in the same reply**, flags doubtful symbols, and asks first (no grade) if a doubt changes the verdict |
| Enforcement | New `read_sketch` tool + gate: `conclude` refuses a solved outcome while a sketch is unread or has open doubts |

---

## 1. Codebase audit summary

**(a) UI rendering.** The web UI is about 29.7k lines in `components/`, plus about 4k lines of client logic in `src/core` and 3k of figure code.
- Routes: `app/**/page.tsx`. Every page is a dynamic Server Component; output is `standalone`, so **there is no static bundle**.
- Chat: `components/chat.tsx` (2443 lines; part switch ~L1516-1584, dock ~L1874-2442) and `components/session-core.ts` (POST `/api/chat`, then a fetch-reader SSE on `/api/chats/[id]/stream`). The view projection is `src/core/view.ts`.
- Docks: `components/question-dock.tsx`, `practice-dock.tsx`, `answered-card.tsx`.
- Markdown/math: `components/md-blocks.tsx` and `components/ai-elements/message.tsx` (Streamdown + KaTeX + mermaid), `src/core/math-delims.ts`. Learner text is rendered plain, never as math.
- Figures: `components/figures/*`, with the core in `src/core/figures/*`.
- Demos: `components/artifacts/demo-card.tsx`, a sandboxed `srcDoc` iframe. Visuals: `visual-card.tsx` (inline SVG).
- Graph: `components/graph-view.tsx` + `graph-canvas.ts` (Canvas 2D, d3-force, d3-zoom). Skill map: `components/skill-map.tsx`.
- Electron coupling is only an optional `window.lh` (`electron/preload.cjs`).

**(b) `claude` CLI invocation.** Everything is in `src/agent/claude-code.ts`, registered as a pi-ai provider in `src/agent/models.ts:65`.
- Binary lookup: L69-110 (`LH_CLAUDE_CODE_BIN`).
- Spawn: L616-627. Arguments (L961-997): `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --no-session-persistence --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands --system-prompt-file … --model … [--effort] [--mcp-config … --allowedTools mcp__lh]`.
- Tools reach `claude` through a stdio MCP stub (`process.execPath` running the stub script, L542-588). The stub talks to a token-authenticated TCP bridge on `127.0.0.1:0` (L827). Calls are "held": the pi agent loop runs the real tool and answers the held call.
- Live sessions: at most 6, 40 minutes idle (L513-538, L596-607). Otherwise a fresh process replays the whole transcript as one user message (`renderClaudeCodeRequest`, L237-280).
- **Images are already supported** on this path: `ClaudeCodeInputBlock` L142-144, `userContent` L682-692, `mcpResult` L674-679.
- Turn runner: `src/server/chat-handler.ts`, `turn-service.ts`, `turn-runs.ts`, `src/server/pi/ui-stream.ts`.
- System prompt: `src/agent/system-prompt.md` + `src/agent/prompts/**`, composed by `src/agent/prompt-segments.ts` and passed as `--system-prompt-file`.

**(c) Knowledge graph and session persistence.**
- Paths come from `config.ts`; `LH_DATA_DIR` moves the data directory.
- Graph: append-only JSONL in `data/graph/`: `nodes.jsonl` (propositions), `chains.jsonl` (premises → conclusion, the stored truth; edges are derived), `sessions.jsonl`, `coverage.jsonl`, `skills.jsonl`. Code: `src/store/graph.ts`, `src/store/skills.ts`, `src/store/graph-format.ts`, `src/core/graph.ts`, `src/core/contracts/graph.ts`.
- The **only graph writer** is the extraction pipeline `src/agent/subagents/extraction.ts`. It reads **teacher prose only**.
- Mastery (Leitner boxes) is derived, never stored: `src/core/mastery.ts`, folded from practice `conclude` outcomes and placement verdicts.
- Chats: one JSON file per chat, `data/chats/<id>.json` (`src/store/chats.ts`), rewritten whole and synchronously on each save.
- Materials (the existing pattern for binaries kept outside the chat record): `src/store/materials.ts`.

**(d) Dictation.**
- Capture: `components/dictation.tsx` uses `getUserMedia` into `AudioContext({sampleRate:16000})` and the AudioWorklet `public/worklets/pcm-capture.js`, producing raw Int16 PCM.
- Segmentation: `components/dictation-live.ts` cuts pieces of 8–25 s at 0.6 s pauses.
- Transport: each piece is `POST /api/stt/local?language=en|nb` (`app/api/stt/local/route.ts`).
- Engine: `src/server/stt-local.ts` runs a child process (`src/server/stt/worker.mjs`, `engine.mjs`, `pcm.mjs`) with transformers.js + onnxruntime-node, WebGPU first and CPU second. Models are chosen in `src/core/language.ts:114-131`.
- Cloud alternative: Deepgram (`app/api/stt/token/route.ts`).
- No vocabulary biasing today.

### Corrections to the brief (these change the design)

1. **`skills/learnharness` is not the teaching prompt.** It is a read-only skill that lets an *external* `claude` read the data (Python, standard library). The prompts that need the transcribe-first rule live in `src/agent/prompts/**`. The skill only needs a doc update (a new `sketches` folder) and the `--data-dir` note.
2. **1568 px is the old limit.** Current Claude models (4.7 and later, including Opus 5.5) are high-resolution: 2576 px long edge and up to 4784 visual tokens; cost is ⌈w/28⌉×⌈h/28⌉ tokens. We cap at **2000 px** for a different reason: `claude-code` replays the transcript as one request, and a request with more than 20 images enforces a 2000 px per-image limit.
3. **Single-message `claude -p "…"` can't take images.** Streaming input (`--input-format stream-json`) can, and it is already what the provider uses.
4. **"The knowledge graph" never sees learner text.** So the guardrail has to gate *grading and mastery* (`conclude`), and the `read_sketch` transcription becomes the durable text record of the sketch.
5. **Capacitor/Tauri can't bundle this UI.** There is no static export. Any wrapper must load the live server on `127.0.0.1`, and Capacitor documents `server.url` as a dev-only feature.

---

## 2. Architecture decision matrix

| | Pure native Kotlin/Compose | Pure Capacitor / Tauri v2 (web canvas) | **Hybrid: thin Kotlin shell + WebView + native ink overlay** |
|---|---|---|---|
| Ink latency | Best (front-buffered `InProgressStrokes`, typically single-digit ms) | WebView canvas: compositor-bound, expected around 25–50 ms (measure) | Best where it matters: the canvas is native; everything else is web |
| Palm rejection | Native tool type + `FLAG_CANCELED` + motion prediction | `pointerType` pen-only mode + `pointercancel`; decent with EMR pens | Native |
| Lessons, KaTeX, mermaid, figures, demos, graph canvas | Rewrite about 30k lines; Streamdown/KaTeX/mermaid have no Compose equal; demos need a WebView anyway | 100% reuse | 100% reuse |
| Dev speed | Months before parity | Fastest | Fast. The shell is about 1k lines of Kotlin; the ink overlay is an add-on |
| Upstream sync | Every UI change ported twice | Free | Free (`android/` folder plus generic web changes) |
| Risk | Scope | Ink feel; `server.url` is dev-only; Tauri adds a Rust toolchain for no gain | WebView/native layering for the overlay (prototype first) |

**Recommendation: the hybrid with a plain Kotlin shell, not Capacitor.**
- The WebView renders the **entire** existing UI from the Termux server.
- A transparent-over-native layer gives the stylus `androidx.ink` (1.0.0 stable; Compose interop in 1.1.0-alpha).
- Capacitor's main value, bundling web assets and plugins, doesn't apply here. A thin shell gives direct control of the WebView (mic permission, cookie auth, file chooser, origin-restricted `WebViewCompat.addWebMessageListener` bridge) and adds no npm dependency to the shared app.
- The mic stays in the web layer (the existing worklet).
- The native overlay is built **only if** the measured web-canvas latency on the purchased device misses the bar (milestone M9). The web canvas ships first anyway.

---

## 3. Single-turn data flow (practice problem, handwriting + voice)

1. **Open.** The learner taps "Open in sketch" in the practice dock. `SketchView` (web) opens full-screen, with the problem in a floating box (KaTeX).
   - If `window.lhAndroid?.ink` exists, the canvas is the native overlay; otherwise it is the web canvas.
2. **Talk.** The learner taps the mic in the sketch toolbar.
   - `dictation.tsx` captures through the WebView's `getUserMedia` and the 16 kHz Int16 worklet.
   - `dictation-live.ts` cuts pieces at pauses. Each piece goes to `POST /api/stt/local?language=nb&chat=<id>`.
   - The server's STT engine `whispercpp` builds the vocabulary prompt (§6), wraps the PCM in WAV, and sends multipart `POST http://127.0.0.1:8178/inference` with `{file, prompt, temperature:0, response_format:json}`.
   - The text flows back live into the dock's existing thinking/answer field, shown in a transcript strip.
   - The overlay **binds to the dock's fields and makes no dictation claim of its own.** The claim is global, and releasing it doesn't hand it back, so a claim by the overlay would break dictation in the dock after the overlay closes.
3. **Write.** Native: the MotionEvent stylus path goes to front-buffered ink. Web: pen-only PointerEvents (coalesced and predicted) are drawn as perfect-freehand outlines on the canvas.
4. **Submit.**
   - Wait for `finishDictation()`.
   - Export: bbox crop plus padding, a scale chosen so strokes are at least about 2 px wide, long edge ≤ 2000 px, bands for tall pages, a white background, a margin bracket on the strokes new since the last submit, grayscale PNG.
   - Payload: a `SketchPayload` (§5) — `{id, producer, pages[], page?, newInk?}`.
5. **Server.**
   - `POST /api/chat {type:"thinking", problemCallId, text, sketch}`.
   - `parseChatInput` validates the payload with a shared hand-written validator: page count, edge ≤ 2000, decoded bytes, PNG signature, IHDR size.
   - `persistInputSketch` writes the pages to `data/sketches/<chatId>/<id>/<i>.png`, before the write-ahead, the parallel-question hold-back, or a refused input.
   - The marker's `details` gets only a `SketchRef`, never bytes.
6. **Model input.** The pages are loaded back into the request at the model boundary: `convertToLlm` → `toLlmMessages(messages, {sketchImage})` adds label + image blocks to the marker's user message (or to the answer's tool result).
   - The claude-code provider needs **no change**: it writes stream-json image blocks live through `userContent`, or inlines them in the fresh-process `<transcript>`.
   - Answers ride `mcpResult` image content.
7. **Claude's reply** (`claude` in proot, native linux-arm64) streams back as `stream_event` lines, then the translator, pi events, SSE, and finally the WebView.
8. **Transcribe first.** Claude calls `read_sketch({sketchId, latex, uncertain[]})` through MCP, the stub and the bridge. The server records it, and the UI shows a "Claude read: $$…$$" card with "That's not what I wrote".
9. **Grade.** Claude then gives feedback or a hint in the same reply. A later `conclude(solved)` is refused while that sketch is unread or has open doubts. Mastery folds from `conclude` as before.

The question-dock path is the same, except step 5–6: the sketch rides the answer's tool result (image block(s) plus `"sketch":{id, pages, as}` last in the compact JSON), and the held MCP call is answered with an MCP image result.

---

## 4. Backend in Termux (proot Ubuntu): what has to change

**Runs unchanged once the env is set.** Use the reference headless env from `scripts/smoke-server.mjs:111-121`, plus `HOSTNAME=127.0.0.1` (Next's default is `0.0.0.0`), `LH_DATA_DIR` and `LH_AUTH_FILE` under the guest's `$HOME`, `LH_UPSTREAM_CHECK=0`, `CHROME_PATH` pointing at Playwright's arm64 Chromium (Ubuntu's apt chromium is a snap, which proot can't run), and `LH_PYTHON=python3`.

**Generic code changes** (good for desktop too):
1. **Browser-mode auth.**
   - Today `/api` is completely open headless, and any Android app can reach loopback.
   - Add a token mode: `proxy.ts` + `src/server/desktop-access.ts` accept either the Electron header or an HttpOnly, SameSite=Strict `lh_token` cookie. It covers **pages too**, because Server Components render chat data directly.
   - Add Host/Origin checks against DNS rebinding and CSRF.
   - A pairing URL printed by the start script sets the cookie, so this works in Chrome *and* in the shell. The shell can also set it through `CookieManager`.
2. **New knobs:**
   - `LH_CLAUDE_CODE_MAX_SESSIONS`, default 6; about 2 on Android because of the phantom-process budget.
   - An STT engine selector plus `LH_STT_DEVICE=cpu`, so the device never downloads the 1.3–1.6 GB WebGPU models.
   - `/api/health`, for the shell's server-status screen.
3. **CI.** A new workflow file (upstream's workflows stay untouched) runs `next build` → `build-server.mjs` → smoke test with the fake CLI on `ubuntu-24.04-arm`, and publishes `learnharness-server-<ver>-linux-arm64.tar.zst`.

**Device scripts** (new `android/termux/`). An `lh` command with `install | start | stop | status | update | pair`:
- Holds `termux-wake-lock`.
- Starts `whisper-server` natively, then `proot-distro login ubuntu -- …/start.sh`.
- `update` pulls the CI tarball.
- Documents the Android 12+ phantom-process killer: Android 14+ has a developer-options toggle; 12–13 need `adb` `device_config` commands. Also battery-optimization exemptions (Samsung "never sleeping apps").

**Known on-device costs** (measure in M7):
- proot slows syscalls, and `listChats` re-parses every chat file.
- Up to 2 `claude` processes plus their Node stubs, Chromium per demo, and `whisper-server` all share RAM with the WebView.
- The first submission after each `problem` pose starts a fresh `claude` and replays the whole transcript (`continuation()` L695-710; later submissions on the same problem continue live). With sketches inline, the replay cost grows with problems × pages, so it is a candidate fix in M11. The elision rule (§5) already bounds it.

---

## 5. Handwriting pipeline

### Capture and pre-processing

- **Web canvas** (`components/sketch/*`, new):
  - Pen-only input when a pen has been seen; touch pans and scrolls.
  - `getCoalescedEvents` for full-rate samples in integrals and subscripts; `getPredictedEvents` for draw-ahead.
  - perfect-freehand outlines for pressure; an eraser (pen button / eraser `pointerType`); undo and redo.
  - A tall scrollable page.
- **Export** (pure, unit-tested, in `src/core`, so the native overlay reuses the same rules):
  1. Bbox of all strokes, plus about 32 px padding.
  2. Choose the scale: strokes about 2.5 px or more wide, long edge ≤ 2000 px, never upscale more than 2×.
  3. Split pages taller than 2000 px into bands at blank rows (labeled `[sketch sk_x · page 2/3]`).
  4. White background, black ink (colour kept only if the learner used colours), lossless grayscale PNG.
  5. Bracket in the margin the strokes added since the last submit.
  6. Keep the vector strokes as a sidecar for re-editing.
- **Expected cost:** a typical 1400×700 crop is ⌈1400/28⌉×⌈700/28⌉ = 1250 visual tokens, about $0.005 at Opus 5.5 input rates. On a subscription it counts against rate limits.

### Into the `claude` turn and the session record (code-verified)

- **Contract.**
  - New `src/core/contracts/sketch.ts` defines `SketchPayload {id (producer-minted "sk_…"), producer: "web-canvas"|"android-ink", pages[{mimeType:"image/png", data, width, height}], page?{key, revision, previousId}, newInk?[…]}`. The details record keeps a `SketchRef`: the same fields without bytes.
  - Pure helpers go in a new `src/core/sketch.ts`: `parseSketchPayload`, `sketchRefOf`, `sketchLabel`, `planSketchBands`, and the folds. These are shared by the client, the server and, later, the Android bridge.
- **Input.** An optional `sketch` on the `answer` and `thinking` variants of `ChatInput` (`src/core/input-events.ts`).
  - The server overwrites `answer.sketch` with the ref it derives itself; the current answer cast isn't validated.
  - `AnswerRequest`/`QuestionAnswerData`/`buildAnswer`/`dockSubmitGate` in `src/core/question-core.ts` gain the field (text mode can submit with only a sketch).
  - `compactAnswerForModel` adds `sketch` **last**, so the verdict-first key order is kept.
- **Storage: a blob store, not inline base64.** Chat records are rewritten whole three or more times per turn, `listChats` parses all of them, and `GET /api/chats/[id]` ships them verbatim. So:
  - Port `SketchStore` in `src/core/ports.ts`, adapter `src/store/sketches.ts`, `PATHS.sketches` in `config.ts`.
  - The single writer is the chat-handler input path. Deletion joins `materialStore.removeAll` in `src/server/chats.ts`.
  - `GET /api/chats/[id]/sketches/[sketchId]/[page]` serves the thumbnails.
- **Into the request.** `src/agent/teacher-agent.ts:252` changes to `convertToLlm: m => toLlmMessages(m, {sketchImage})`.
  - Images are added there for practice-thinking markers and for answer tool results.
  - A missing file becomes a text stub; it must never throw.
  - Agent state and SSE stay free of bytes, and the bytes read from disk are identical every time, so the claude-code image hashes stay stable.
- **Smaller fixes:**
  - `src/core/compaction.ts`: estimate sketch pages in `estimateMessageTokens`. In `serializeForSummary`, fix array content and write `[image]` instead of base64 (a latent bug today with `read`-tool images).
  - Hide "Open in sketch" when the session's model lacks image input; pi-ai would otherwise drop the images silently.
- **Cost bound on replay** (M2). The pure `sketchReplayPlan` in `toLlmMessages` replaces a sketch with `[sketch sk_x · page i/n — omitted; its confirmed reading is your read_sketch call]` only once it is **confirmed** and its **scope is closed** (a newer problem was posed, or a later answer was given). Each projection then changes at most once.
  - `messageFingerprint` (claude-code.ts L632-645) must hash the image form and the stub form the same way, so live sessions keep reusing the prefix.
  - Compaction writes sketches as `[sketch sk_x — read as: …]`.

### Transcribe-first guardrail (code-verified)

- **Prompt segment.** New `src/agent/prompts/shared/18-sketches.md`.
  - Prober and teacher pick it up automatically (`prompt-segments.ts:93`); it is added to `PRACTICE_SHARED_FRAGMENTS` and `PLACEMENT_SHARED_FRAGMENTS` (L43, L49), and the prompt-override test pin is updated.
  - Rules:
    - Call `read_sketch` first, in the same reply.
    - Transcribe **exactly what is written, errors included; never correct**. The reading is shown to the learner, so a "fixed" reading would give the answer away.
    - Diagrams get a structural reading (blocks, arrows, labels).
    - Put every doubtful symbol in `uncertain`. If a doubt could change the verdict, ask and don't grade; re-read after the learner answers.
    - A garbled stroke is a recognition slip, not a conceptual one (mirrors the "transcribed speech" rule).
    - On MC the sketch is thinking: the recorded pick and verdict stay authoritative.
    - On a whole-page resubmit, respond to the bracketed new ink.
  - `newAnswerResult` gets a sketch-aware `next` text. Today's "Reply in text before any tool" (`prose-gate.ts:37`) contradicts read-first.
- **`read_sketch` tool.** New `src/agent/tools/sketch.ts`, `{sketchId, latex, uncertain: string[]}` (plain-language doubts; LaTeX in arrays gets double-escaped in replays).
  - Registered **always** for prober, teacher, practice and placement. Toggling it would change the tool hash and force claude-code respawns and cache misses.
  - Execute checks that the sketch exists in the record and returns an ack. The call and its result *are* the record fact, written by `persistTurn`: no new store, no new writer.
  - Card: `components/artifacts/read-sketch-card.tsx`, registered in the artifact renderer registry. It shows the thumbnail, the reading in KaTeX, the doubts, and "That's not what I wrote" (a dispute input).
- **Gate.** A pure `sketchGateOf(messages)` seeds a closure in `PracticeGate` (`src/agent/tools/practice.ts`). It has to be a closure because a `[read_sketch, conclude]` batch isn't visible in the frozen record mid-batch.
  - `conclude` returns `invalidInputResult` for `solved`/`solvedWithHints` unless the newest sketch on the active problem is read, with no doubts and no dispute.
  - A refused conclude is never mastery evidence; `mastery.ts` folds only clean concludes.

---

## 6. Local dictation on Android

| | whisper.cpp `whisper-server`, native in Termux | sherpa-onnx / whisper.cpp JNI inside the APK | existing transformers.js worker in proot |
|---|---|---|---|
| Speed on an ARM CPU | Good (NEON/dotprod/i8mm, quantized GGML, mmap) | Good; NNAPI/QNN possible | CPU only (no WebGPU in Node on Android) |
| Vocabulary prompt | **Per-request `prompt` field** | sherpa-onnx Whisper: none; whisper.cpp JNI: yes | `prompt_ids` not implemented in transformers.js 4.3.1 |
| Norwegian | NbAiLab ships nb-whisper GGML (q5_0: small 175 MB, medium 539 MB, large 1.08 GB) | Needs conversions | Current ONNX models |
| Fit with the existing UX (live pieces, targets, withdraw, retry, settings) | **Unchanged.** Only a new server engine adapter | Duplicate pipeline in Kotlin plus a bridge | Unchanged |
| Upstream / desktop | Adapter works on Windows too, so it can be built and benchmarked before the device exists | Android-only | — |

**Decision: whisper.cpp `whisper-server` as a new engine behind `src/server/stt-local.ts`.**
- Bound to `127.0.0.1`; one server per language (nb, en), started on demand.
- Desktop keeps transformers.js as its default; the engine is selectable.

**Microphone.** Capture stays in the WebView (Web Audio → worklet → 16 kHz mono Int16); Chromium uses Android's native audio input underneath.
- Termux can't stream the mic. Termux:API's recorder writes files, needs another app, and Android blocks background mic use without a foreground microphone service.
- The shell grants `RECORD_AUDIO` and answers `onPermissionRequest`.
- A native `AudioRecord` fallback is planned only if the WebView capture fails on the device.

**Vocabulary prompt.**
- A pure core function `dictationVocabulary(record, course, graph)`, cached per chat. Inputs: course skill names, picked graph propositions (the graph-context marker), plan-tree node titles, the active question/problem stem, and recent teacher terms.
- Output: about 150 tokens or fewer, a comma list in the lesson language. Whisper prompts are capped at 224 tokens and also steer punctuation and casing.
- Sent as whisper.cpp `prompt`.
- Watch for hallucinated prompt words on silence. The worker's existing silence skip (peak < 0.01) is kept.

**Speak while sketching.**
- **v1:** one dictation run and one canvas session feed one submit. The transcript is the `text`/`thinking` field, and the image(s) are the sketch: one multimodal turn.
- **v2 (optional, later):** time anchors. Stroke groups get small numbered markers drawn in the image, and `⟨3⟩` tokens are inserted into the transcript at the time the group was drawn, so "this term here" can be resolved.

---

## 7. Phased roadmap (small, testable milestones)

Track A runs on the Windows PC, no device needed. Track B needs an Android device. M0 runs on your existing arm64 phone (owner: yes), in parallel with M1, and its numbers feed the tablet choice.

| # | Milestone | Done when |
|---|---|---|
| **M0** (parallel with M1) | Feasibility spike on your arm64 phone, no repo changes: Termux → proot Ubuntu → Node 26, `claude` login, a stream-json round trip **with an image**, Playwright Chromium headless launch, whisper.cpp build + bench (nb small/medium, a 30 s clip) | Notes with numbers (`docs/android/feasibility.md`) |
| **M1** (lowest-risk vertical slice) | Plain web canvas (`components/sketch/*`) from the practice dock and the question dock (text mode) → `SketchPayload` → blob store → `toLlmMessages` loads the images → Claude replies; thumbnails in the thinking/answered cards. Plus the compaction token estimate and the serializer fix | New `tests/sketch-contract.test.ts`; extend `question-core`, `practice-record`, `session-core`, `claude-code(-live)` tests (fake CLI logs block types: an answer with an image continues on the same process); chat/practice flow: the file is written before write-ahead, a bad payload gets a 400 and nothing is written. **Live check:** Claude Code passes MCP image results through |
| **M2** | `read_sketch` tool (4 agents) + `shared/18-sketches.md` + "Claude read:" card + dispute + `conclude` gate + sketch-aware `next` + replay elision with fingerprint normalization + compaction rendering | Gate fold tests (unread / doubtful / disputed / read; batch `[read_sketch, conclude]`); fingerprint equality (image vs stub); prompt pin updated; manual: an ambiguous sketch makes Claude ask instead of grading |
| **M3** | Full sketch view: draggable floating box (KaTeX), MC options + confidence inside it (bound to the dock's own `sel`/`confIdx` state), kept page with new-stroke brackets, undo/eraser, pen-only palm handling, tall-page bands, mic in the toolbar (bound to the dock's fields, no new claim). Also overlay-aware Enter/keyboard machine and the overlay root `lh-no-drag` (Electron drag band) | Interaction tests (linkedom pattern) + manual pen test on Windows |
| **M4** | STT engine seam + whisper.cpp adapter + vocabulary prompt (Windows whisper.cpp binaries) | WER/latency bench like the 2026-10-25 FLEURS run, with and without the prompt, on a technical-term clip |
| **M5** | Tablet/touch layout pass: sidebar overlay below ~1024 px, Enter inserts a newline on coarse pointers (send button submits), hover-only affordances visible on `(hover:none)`, tap tooltips, skill-map scroll trap + pinch, long-press menus, full-screen settings on small screens, safe-area insets | Chrome device emulation + Windows touch; render tests |
| **M6** | Headless hardening: token-cookie auth + Host/Origin checks (pages too), `/api/health`, `LH_CLAUDE_CODE_MAX_SESSIONS`, `LH_STT_DEVICE`; linux-arm64 CI workflow + tarball | CI green on the arm64 runner, with a smoke test against the fake CLI |
| **M7** | Device bring-up: `android/termux/lh` scripts (install/start/stop/status/update/pair), whisper-server in Termux, server in proot. **The app works in Android Chrome via the pairing URL, with no APK yet** | A full lesson on the device (dictation, web-canvas sketch, demo); memory/latency numbers |
| **M8** | Android shell APK (`android/app`, Kotlin): WebView + cookie pairing, mic permission, file chooser, edge-to-edge insets, back navigation, server status + start via Termux `RUN_COMMAND`, dev mode against the PC through `adb reverse tcp:3000 tcp:3000` | Install on the device; the M7 checklist passes inside the shell |
| **M9** | Ink decision gate: a 240 fps slow-motion camera test of the web canvas (shell + Chrome) against a minimal native `InProgressStrokes` screen, plus a dense-notation writing test (subscripts, matrices, integrals) | Recorded numbers; owner decides whether to build M10 |
| **M10** (if needed) | Native ink overlay: `InProgressStrokesView` under a transparent WebView. The Activity routes stylus events, and touches outside the floating-box rects reported by the web, to the ink layer. Export to the **same** sketch payload through the bridge | Same M1–M3 tests pass with `lhAndroid.ink`; latency re-measured |
| **M11** | Device performance and lifecycle: live continuation for practice submissions (no respawn), chat-list parse cost, wake-lock/killer runbook, RAM budget | Before/after timings on the device |
| Later | Speak-while-sketching time anchors; phone-width layout | — |

---

## 8. Hardware advice (device undecided)

A tablet with an EMR or active pen and **12 GB or more of RAM**; 16 GB is preferable. The budget: Android itself, plus the WebView, Next server, 1–2 `claude` processes, `whisper-server` (0.5–1.3 GB depending on the model) and Chromium during demos.
- A Galaxy Tab S-series with the S Pen in the box (Wacom EMR, hardware palm rejection) is the safest pick.
- Avoid devices with 8 GB or less.
- A current flagship ARMv9 chip (dotprod/i8mm) matters for whisper.cpp.

## 9. Verification (overall)

- Track A milestones are verified with `npm test`, `npm run typecheck` and `npm run lint` (10 known Windows failures are pre-existing), the fake-CLI provider tests (`tests/fixtures/claude-code/fake-claude.mjs`, call `closeClaudeCodeSessions()` in `after()`), and manual runs in the installed desktop app (the release workflow).
- Track B milestones are verified on the device with the M7 checklist: start, pair, a lesson, a quiz answered by sketch, a practice problem with sketch + voice, a demo, a restart that survives, and a screen-off turn with the wake lock.

## Open items to settle at their milestone (not now)

- M1: exact payload limits (proposed: ≤ 6 pages, ≤ 1.5 MB per page, ≤ 6 MB total). Does a text-only dock submit attach the current page? Does a re-submit with no new ink re-send it? Page persistence across a reload: memory, sessionStorage strokes, or the last raster? Does Enter submit inside the sketch view?
- M2: does the gate check only the newest sketch (proposed) or all of them? Does `solvedWithHints` count as solved for the gate (proposed: yes)? The dispute flow in teach mode, and when the button shows. Card wording when the session model isn't Claude.
- M4: which nb/en models and how many threads (from the bench).
- M8: pass the pairing token via a `RUN_COMMAND` argument or stdin; Termux:Boot autostart or not.
- M10: the layering fallback if transparent-WebView routing fails.

## Sources

- [androidx.ink releases](https://developer.android.com/jetpack/androidx/releases/ink)
- [Claude vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Agent SDK streaming input (images)](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [whisper.cpp server README](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md)
- [NbAiLab nb-whisper GGML files](https://huggingface.co/NbAiLab/nb-whisper-large/tree/56c9073896542ced452efef60dc355894c167114)
- [Claude Code on Termux (glibc/proot)](https://cosyra.com/guides/claude-code-termux-fix.html)
- [Phantom process killer notes](https://github.com/agnostic-apollo/Android-Docs/blob/master/en/docs/apps/processes/phantom-cached-and-empty-processes.md)
- [Termux RUN_COMMAND security notes](https://termux.dev/en/posts/security/2022/02/15/termux-apps-vulnerability-disclosures.html)
- [Capacitor 8](https://ionic.io/blog/announcing-capacitor-8)
- [Chrome desynchronized canvas](https://developer.chrome.com/blog/desynchronized)
