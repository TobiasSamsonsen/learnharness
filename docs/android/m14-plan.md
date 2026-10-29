# M14 plan (DRAFT): merge upstream v0.4.0 into the fork

Status: **DRAFT, awaiting owner approval. Nothing is changed yet.** Written by Claude on 2026-10-29 from a dry-run merge in a scratch worktree (the working tree was not touched) and two read-only surveys of the two Claude CLI providers. Per AGENTS.md "No guessing", the owner's rule and answers are below; every other choice is mechanical consequence of them.

## Owner rule (2026-10-29)

> If upstream adds the same features, we keep upstream's features, to minimize future work. But we should not remove important features in our fork when upstream doesn't have them.

Applied as: on every feature both sides have, the fork takes upstream's implementation; every fork-only feature stays, ported onto upstream's code as a small, isolated hook so the next merge stays cheap.

| # | Owner decision |
|---|---|
| Q1 | The rule above |
| Q2 | Claude Code opt-in: keep upstream's explicit opt-in on desktop; on Android a **successful in-app Claude sign-in sets the opt-in** (signing in is the explicit action) |

## What is coming in

- Base: the fork's last merge, `v0.3.9`. Target: tag `v0.4.0` (`dc4c398`, `upstream/main`). **61 upstream commits, 158 files**; the fork has 147 commits and 404 files changed since the same base. 47 files changed on both sides.
- Dry run (`git merge --no-commit upstream/main` on the fork tip): **22 files conflict** (about 30 hunks), 47 auto-merge. One add/add: `tests/fixtures/claude-code/fake-claude.mjs`. The conflicts: `components/{ai-elements/message,chat,composer,dictation,home,practice-dock,question-dock,reading-thinking,session-core,session,settings-signal}`, `components/settings/keys-section.tsx`, `src/agent/models.ts`, `src/core/{contracts/models,native-messages,settings,view}.ts`, `src/server/model-catalog.ts`, `package.json`, `package-lock.json`, `tests/session-core.test.ts`.
- Themes of 0.4.0: **a Claude CLI provider** (`src/agent/claude-code/*`, an in-process MCP tool bridge, install/version gating, explicit opt-in, context-window probe), **custom OpenAI-compatible endpoints** as a first-class provider (vision and context from `/models`, thinking levels, local limit pins, manual model ids), **desktop file-path chips** in the composer, pending-question dock fixes, math preserved through streaming repair, image normalization for model input, Next and Electron bumps.

## Where the two sides were joined (the decision that matters)

**Two Claude CLI providers exist.** The fork has its own (`src/agent/claude-code.ts`, one file, with a stdio MCP stub, a loopback bridge and a session state machine). Upstream 0.4.0 has a different one (`src/agent/claude-code/*`). Both register the provider id `claude-code`. By the owner's rule **upstream's provider is adopted and the fork's is removed**. They are close in design (stream-json over a spawned `claude`, held MCP calls answered by the next call's tool results, live process reuse by prefix match, whole-transcript replay on a respawn, images as image blocks), so the move is mostly deleting fork code.

### What the fork's provider does that upstream's does not (kept, ported as hooks)

| # | Fork-only feature | Where it goes on upstream's provider |
|---|---|---|
| P1 | **Replay elision**: a concluded practice problem is replaced by one `<omitted>` note once a later problem is posed (`elidedProblems`) | One function applied where upstream's `transcript.ts` builds the fresh-spawn input (it is only used on a respawn, so the live prefix check is untouched, as in the fork today) |
| P2 | **Sketch fingerprint equality**: a sketch page as an image and as a text stub count as the same message, so a read-and-closed sketch does not force a respawn | One comparison tweak in upstream's `reuse-context.ts` (`SKETCH_LABEL_RE`) |
| P3 | **Plan usage**: the `rate_limit_event` is stored and served by `/api/claude-code/usage` for the plan pill (`components/plan-usage.tsx`) | A line in upstream's stream parser that records the event; the route and pill stay (upstream's `/api/claude-code` status route sits beside it) |
| P4 | **Operating knobs**: `LH_CLAUDE_CODE_MAX_SESSIONS` (an LRU cap, 2 on the phone), `LH_CLAUDE_IDLE_MIN` (the owner's 40 minutes, upstream has a fixed 10), `LH_CLAUDE_CODE_DEBUG` | In upstream's `live-processes.ts` |
| P5 | **Child environment**: also drop `LH_ACCESS_TOKEN` (upstream's `externalCliEnv` drops only key-store injections) | One line around upstream's env |
| P6 | **Android**: models seeded on first run (`Logic.kt`), the app's own sign-in (`ClaudeLogin.kt`), and the opt-in set when that sign-in succeeds (Q2) | Seeding stays; a success hook sets `settings.claudeCode.enabled` through the server's settings route |
| P7 | The `send_to_user` and force-text handling that treats `claude-code` specially (`teacher-agent.ts`) | Re-checked against upstream's version of the file |

Checked and fine as is: the phone's pinned CLI (`2.1.312`) is above upstream's minimum (`2.1.259`); the guest's `HOME`/`PATH` match what upstream's binary lookup expects; Windows looks for `claude.exe`, which is what is installed.

### Other overlaps (take upstream, keep the fork's layer on top)

- **Dock and message components** (`question-dock`, `practice-dock`, `reading-thinking`, `composer`, `chat`, `home`, `message`, `session*`, `view`, `native-messages`): upstream's pending-question fixes come in; the fork's confidence buttons, sketch entry points, `send_to_user` prose handling and dictation engines stay.
- **Models and settings** (`models.ts`, `contracts/models.ts`, `model-catalog.ts`, `settings.ts`, `keys-section.tsx`, `settings-signal.ts`): upstream's custom-endpoint provider and settings come in; the fork's `claude-code` seeding and presets are re-pointed at upstream's provider.
- **`package.json` and the lock file:** take upstream's dependency set, keep the fork's additions (`@resvg/resvg-js`, ink and sketch libraries), regenerate the lock with `npm install`. Version becomes `0.4.0`.
- **Tests:** upstream's tests come in. The fork's tests of its own provider internals (`claude-code.test.ts` state machine) go with it; the fork-only behaviours (P1, P2, P3, P4, sketch-reading's `messageFingerprint` import, the prose gate) get tests on the new provider. `fake-claude.mjs`: upstream's fixture, extended for `rate_limit_event` and sketch images.

## Steps (one commit each, tests green before the next)

1. Branch `merge/upstream-v0.4.0` from `feat/m13-sketch-v2` (so the sketch work and the earlier merge are in the base; **M13 is not on `main` yet**).
2. `git merge upstream/main`; resolve the 22 files by the rules above; regenerate the lock; typecheck.
3. Remove the fork's provider; wire everything to upstream's (`models.ts`, `model-catalog.ts`, `upstream.ts`, keys and preset routes, `plan-usage`); typecheck and run the existing suite to see what fails.
4. Port P1 to P5 and P7 with tests; port the tests of the sketch and practice paths.
5. Android: P6, Kotlin tests, `assembleDebug`; Kotlin side unchanged otherwise.
6. Verify: lint, typecheck, `npm test` (the 12 known Windows failures aside), Kotlin tests. Real checks: one real short turn through the desktop app on the new provider (uses a few subscription calls), and the Pixel with the debug APK and the PC dev server: sign-in opt-in path and one turn if the account allows.
7. Docs: STATUS entry for the merge, `m11-plan.md`/`m12-plan.md` mentions of the removed provider, a note in `docs/android/plan.md` where it names the provider file.

## Risks to watch

- **Stricter tool admission**: upstream fails a turn with a compatibility error unless every streamed tool call is pending on the bridge with identical arguments. The fork's question and problem tools must still pass (they do in the fork's tests today; re-checked on the new provider).
- **Live reuse and the sketch gate**: any fork message projection that rewrites earlier messages (sketch pages becoming stubs) must keep the prefix check true or cost a respawn; that is what P2 is for.
- **The phone**: first real run of the upstream provider inside proot is not something the PC can prove; it is listed as unverified until the owner runs it.
