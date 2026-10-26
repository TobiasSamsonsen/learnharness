# M6 plan: headless hardening + linux-arm64 CI

Status: **approved and implemented** (2026-10-26); see STATUS.md. Parent: [plan.md](plan.md) §4 and §7 (M6). Track A, no device needed.

## Owner decisions (this session)

| Topic | Decision |
|---|---|
| Token mode | On only when env `LH_ACCESS_TOKEN` is set. Unset = open as today (desktop, dev, upstream smoke unchanged). The Android start script generates the token and prints the pairing URL |
| Pairing | `GET <any page>?lh_token=<token>` with a valid token sets the HttpOnly, SameSite=Strict `lh_token` cookie and redirects to the same URL without the query. No valid cookie: a plain 403 page (hint: use the pairing URL) for pages, JSON 403 for `/api` |
| Host/Origin | Host must be `127.0.0.1`, `localhost` or `[::1]` (any port), plus optional `LH_ALLOWED_HOSTS` (comma list). For non-GET/HEAD requests an `Origin` header, if present, must match `Host`; a cookie-authenticated mutation with no `Origin` is rejected. Pages and API |
| Health | `GET /api/health`, public (Host-checked only): `{ok:true, version, tokenMode:boolean}` and nothing else |
| `LH_STT_DEVICE` | `auto` (default, unchanged) \| `cpu`. With `cpu` the transformers.js engine is handed only the existing small CPU model: no GPU repo is downloaded. Status and prepare report that model; settings copy says "CPU" instead of "GPU unavailable, using the small CPU model". Language table untouched; whisper.cpp unaffected |
| `LH_CLAUDE_CODE_MAX_SESSIONS` | Exported pure parser: unset / empty / non-integer / < 1 → 6, otherwise the integer (no upper cap). Read where `evict()` runs |
| CI | New workflow file, `workflow_dispatch` + tags `v*`, `ubuntu-24.04-arm`, uploads `learnharness-server-<ver>-linux-arm64.tar.zst` as a workflow artifact (retention 7 days). No Release creation yet |
| Smoke | New `scripts/smoke-headless.mjs`; `smoke-server.mjs` stays untouched |

## Applied as the plan says (no choice left; shout if you disagree)

- The Electron header path (`x-learnharness-desktop`, `LH_DESKTOP_*`) is unchanged and wins when `LH_DESKTOP_SERVER=1`. Token mode is the browser branch.
- The token is compared with `timingSafeEqual`; it must be at least 32 characters, otherwise token mode fails closed (every request 403).
- The cookie is accepted on pages and `/api`; there is no `Authorization` header form.
- `proxy.ts` matcher widens from `/api/:path*` to everything except `_next/static`, `_next/image`, `favicon.ico`; `/api/health` is handled inside the proxy. Public assets under `public/` (worklets, fonts) also need the cookie in token mode, which they have after pairing.
- The existing assertion that the matcher does not cover `/chat/new` (`tests/desktop-api.test.ts:55-56`) is replaced; browser-only open access (`:49`) is kept.
- Env docs go in the existing README paragraphs (Claude Code, Local dictation) plus a short "Headless server" subsection.
- The arm64 tarball is built from `.next/standalone` by `build-server.mjs` after `npm ci`, `npm run build`, run natively on the arm runner. Its smoke uses a `#!/bin/sh` shim running `fake-claude.mjs` as `LH_CLAUDE_CODE_BIN`, like `tests/claude-code-live.test.ts`.

## Design

### 1. Token mode (`src/server/access-gate.ts`, new; `proxy.ts`)

Pure `accessDecision({url, method, headers, cookies}, env)` returning one of `allow`, `pair` (set cookie + redirect target), `deny` (status + kind page|api). `proxy.ts` calls it after the existing desktop check. Order: Host check → `/api/health` allow → pairing query → cookie check → Origin check for mutations.
- Header-based desktop mode is still decided by `desktopAPIAuthorized`; token mode only applies when `LH_DESKTOP_SERVER !== "1"` and `LH_ACCESS_TOKEN` is set.
- 403 page body is a tiny static HTML response, no Server Component render, so no chat data can leak.
- The pairing redirect keeps the path and every query param except `lh_token`.

### 2. Knobs

- `parseMaxSessions` in `src/agent/claude-code.ts` (exported), used at the `evict()` site (`:899`).
- `LH_STT_DEVICE`: `sttDevice()` next to `sttEngine()` in `src/server/stt-local.ts`; `specs()`, `markLoading()` and `localSttStatuses()` use the CPU model as primary when `cpu`; `components/settings/language-section.tsx` copy follows `ranOn` / device.
- `app/api/health/route.ts`: version from `package.json`.

### 3. CI + smoke

- `.github/workflows/android-server.yml`: checkout, setup-node 26, `npm ci`, `npm run build`, `node scripts/build-server.mjs`, `node scripts/smoke-headless.mjs`, then `tar --zstd` of `.next/standalone` (after a `zstd --version` check) into `learnharness-server-<ver>-linux-arm64.tar.zst`, `actions/upload-artifact@v7`.
- `scripts/smoke-headless.mjs`: boots standalone with `LH_ACCESS_TOKEN`, `LH_CLAUDE_CODE_BIN`=shim, `FAKE_CLAUDE_SCRIPT`; asserts no-cookie page and API → 403; foreign Host → 403; `/api/health` public; pairing sets cookie and redirects; with the cookie: `POST /api/chats`, `PUT /api/chats/{id}/settings` (claude-code model), `POST /api/chat`, SSE shows the fake's text and `[DONE]`; a cross-origin mutation → 403. Always kills the child; boot timeout 60 s.

## Tests

- `tests/access-gate.test.ts` (pure decision table: host, pairing, cookie, origin, health, short token, desktop mode precedence).
- `tests/desktop-api.test.ts` updated for the new matcher.
- `parseMaxSessions` cases (in `tests/claude-code.test.ts`); `LH_STT_DEVICE` cases (`stt-local` specs/statuses); `/api/health` shape.
- Verified with `npm run typecheck`, `npm run lint`, `npm test` (10 known Windows failures), a local `smoke-headless` run on Windows, and the workflow on the arm runner (needs a push; I will not push without being asked).

## Not in M6

`android/termux/lh` scripts and exporting `LH_ACCESS_TOKEN` / `LH_STT_DEVICE=cpu` / `LH_CLAUDE_CODE_MAX_SESSIONS=2` / `LH_WHISPER_URL_*` (M7); publishing the tarball as a Release asset (decided in M7); a richer health/status route (M8/M11).
