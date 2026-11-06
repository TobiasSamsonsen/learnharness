# Development

For product setup, see [Getting started](getting-started.md). For runtime flows, see [Architecture](architecture.md). These guides follow [the repository source](README.md#about-these-docs).

## Setup

CI and release builds use **Node 26**. Use the lockfile and a compatible native build environment:

```sh
npm ci
npm run dev            # normally http://localhost:3000
npm run desktop:dev    # Next dev + Electron on localhost:3000
```

No key is needed to open the UI. Configure connections and the Strong/Cheap/Vision slots before model-driven use; there are no factory model selections. OpenRouter is supported, not mandatory.

```sh
npm run build          # Next production build, including standalone output
npm start              # serve the production build with Next
```

`npm run desktop:dist` is the local **signed macOS** packaging path, not a portable unsigned shortcut. Prerequisites and Windows/Linux instructions are in [Desktop builds and releases](desktop-release.md).

## Run CI locally before pushing

CI (`.github/workflows/ci.yml`) runs typecheck, tests and lint on **Ubuntu 24.04 with Node 26**. The project is developed on Windows, where some tests behave differently (a 12-hour clock, file modes, shell scripts, path separators), so a green `npm test` on Windows does not mean a green CI, and every failed push mails the owner. Run CI itself on a clean copy of your commit first:

```bash
npm run ci:local       # npm ci (only when package-lock.json changed), typecheck, tests, lint: all four always run
```

It tests the commit `HEAD` (commit first; `LH_CI_REF=<sha>` picks another, `LH_CI_WORKTREE=1` tests uncommitted changes, with Windows line endings). On Linux and macOS it runs directly; on Windows it runs inside WSL. The first run installs dependencies (a few minutes); later runs reuse them in `~/.cache/lh-ci`. Per-step logs are in `~/.cache/lh-ci/logs/` inside the distro.

**One-time WSL setup on Windows** (what the project's CI runner has, as far as the tests can tell):

1. Enable WSL2 (`wsl --install --no-distribution`, then restart if asked) and import the official Ubuntu 24.04 image, checking its checksum against `https://releases.ubuntu.com/noble/SHA256SUMS`: `wsl --import Ubuntu-24.04 <folder> ubuntu-24.04.5-wsl-amd64.wsl --version 2`.
2. Inside it, as root: `apt-get install -y git curl xz-utils ca-certificates rsync python3 make g++ unzip`, then Node 26 from nodejs.org (`https://nodejs.org/dist/index.json` lists the latest v26; extract the linux-x64 tarball into `/usr/local` with `--strip-components=1`, after checking it against that release's `SHASUMS256.txt`).
3. `npm run ci:local` finds the distro by name; set `LH_CI_WSL` to use another one.

**Optional pre-push hook:** `git config core.hooksPath .githooks` makes a push to `main` run this first and refuse when CI would fail (`git push --no-verify` skips it once; `git config --unset core.hooksPath` turns it off). It is off by default because it adds about five minutes to each push to `main`.


## Configuration

Nonsecret settings are deltas in `<data root>/settings.json`; absent values resolve through `src/core/settings.ts` and `settings-resolution.ts`. Models and role overrides are settings, not environment variables. [Prompt overrides](../src/agent/prompts/README.md) live under `<data root>/prompts/` and require explicit enable switches.

| Variable | Purpose |
| --- | --- |
| `LH_DATA_DIR` | Mutable chats/jobs/graph/settings/prompts; default repo `data/`. |
| `LH_AUTH_FILE` | Keys/custom-endpoint binding; default repo-root `auth.json`, outside `data/`. |
| Provider API-key variables | Optional, selected-provider dependent; UI names are in `src/core/auth-keys.ts`. |
| `TAVILY_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `OLLAMA_API_KEY` | Optional search adapters. Without a Settings pin, the first keyed engine wins: Tavily → Brave → Exa → Firecrawl → Ollama. A pinned engine requires its own key; no silent fallback. Ollama search is hosted at ollama.com, not a local model server. Page fetching is independent; research can fetch known URLs without a search key. |
| `DEEPGRAM_API_KEY` | Optional dictation token minting. |
| `CHROME_PATH` | Chrome/Chromium executable fallback for demo verification; Electron's browser helper is primary. No extra Chromium is downloaded. |

Ordinary Next development can read `.env.local`. Real environment keys take precedence over saved keys. Saved auth is restrictive-permission plaintext, not an encrypted vault. Packaged Electron sets separate data/auth locations under `userData`; it does not use the repo development profile.

Provider-specific setup and limitations: [Claude Code](claude-code.md), [custom endpoints](custom-providers.md), [context/cost accounting](compaction-accounting.md).

### Subscription connections in web/dev

`npm run dev` and `npm start` support ChatGPT, GitHub Copilot, and Grok sign-in. `desktop:dev` uses those same dev-server connections; packaged desktop has a separate main-process credential owner/private transport. Subscription routes do not fall back to API-key billing.

Web/dev writes `chatgpt-credentials.json`, `github-copilot-credentials.json`, and `xai-credentials.json` **beside `LH_AUTH_FILE`**, in the repo by default—not under `data/` or a global Pi profile. Git/build exclusions cover these files and their write temporaries. Refresh serialization is process-local: use one server per credential directory.

ChatGPT's callback listener is `127.0.0.1` on the **server's machine**; complete sign-in in a browser there. Copilot/Grok use device codes. Allow the initiating browser's sign-in tab if blocked; Electron dev opens provider pages in the system browser. Connected browsers share server credentials, background-use consent, keys, and learning data.

This is **trusted local/shared development**, not multi-user hosting. Same-origin JSON/custom-header checks and short-lived, origin-bound, one-use browser-opening actions are not user authentication or DNS-rebinding protection. Do not expose the server to untrusted users/public Internet without an independent access/host gate. Per-user isolation, remote ChatGPT callback routing, and credential import are not implemented.

## Safe local work

Use a disposable data root and a separate empty `{}` auth file:

```sh
LH_DATA_DIR=/absolute/path/to/scratch/data \
LH_AUTH_FILE=/absolute/path/to/scratch/auth.json \
npm run dev -- --port 3001
```

These variables isolate app records/saved keys, **not every external effect**. Ambient keys still win; subscription files follow the auth directory; Claude Code can use its native profile. File tools have broad read access under the server's user, subject to the [path guard](architecture.md#file-access-and-external-services). A scratch data root is not a filesystem or credential sandbox. Use synthetic fixtures/fake providers for automated reproduction and avoid personal files or ambient credentials.

Do not commit `.env.local`, credentials, or learning records. Do not copy a personal profile into a fixture. Avoid separate writers against live profiles; store initialization and maintenance scripts can mutate data or invoke model stages. Inspect scripts before using them. See [storage and compatibility](architecture.md#storage-and-notifications) before changing formats.

Read the relevant installed Next guide under `node_modules/next/dist/docs/` before framework-facing changes. The import restrictions live in `eslint.config.mjs`; they do not enforce every architectural convention. [Architecture's code map](architecture.md#code-boundaries) and [prompt composition](../src/agent/prompts/README.md) identify the main entry points.

## Checking a change on a phone

Run the PC's code in the Android app, with a throwaway data root (see above), instead of building the server bundle:

1. `LH_DATA_DIR=<empty dir> npm run dev`, then `adb reverse tcp:3000 tcp:3000`. If the app's own server is already listening on the phone's port 3000 the reverse fails ("Address already in use") and the WebView silently shows the phone's server: `adb shell am force-stop dev.learnharness.android` first, then reverse.
2. Start the debug APK in dev mode: `adb shell am start -n dev.learnharness.android/.MainActivity --ez lh.dev true`. It sticks until you start it with `--ez lh.dev false`; in dev mode the app never provisions its own server.
3. `next dev` blocks client chunks requested from `127.0.0.1` unless `allowedDevOrigins` allows it (it does, in `next.config.ts`); without that the page renders and never hydrates. The first compile of a route over the phone takes about ten seconds, so give a page time before judging it.
4. `/dev-sketch` mounts the sketch view with the throwaway ink key `dev-sketch` (a 404 in a production build), to seed ink and try the erasers without a lesson.
5. Debug builds enable WebView debugging: find the socket with `adb shell cat /proc/net/unix` (`webview_devtools_remote_<pid>`), `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`, then use the DevTools protocol on `http://127.0.0.1:9222/json`.
6. `adb shell input swipe` and `input motionevent DOWN|MOVE|UP` inject finger touches through the native ink layer. Start at least ~100 px (device px) in from the screen's side edge: closer is Android's Back gesture and leaves the page.

The dev server and the installed app share the origin `http://127.0.0.1:3000`, so a device with real data keeps its settings and unsent ink in the same `localStorage`: never clear it there; remove only keys you created. `next dev` rewrites a heading in `AGENTS.md` when it starts: `git checkout AGENTS.md` before committing.

## Debugging

- `LH_PROVIDER_EVENTS=1` saves raw provider events under the selected data root. They may contain private lesson/provider content.
- `LH_BACKGROUND_CAPTURE=auditor` (or comma-separated roles, or `all`) captures background requests/results. Roles are `researcher`, `demoBuilder`, `extractor`, `auditor`, `visualMaker`, and `pdfReader`; foreground teaching/probing is excluded.

For example:

```sh
LH_BACKGROUND_CAPTURE=auditor npm run desktop:dev
```

The flag must reach the **Next server**; restart an existing server to change it. Captures are off by default and written to `<data root>/debug/background-captures/<role>-<run ID>.json`. Each file retains the last request and response/error/tool results, with prior conversation in that request and compact per-turn timings—not every request body.

`request.format: provider` means adapter-exposed outgoing payload after app transport restrictions; `context` means model-facing conversation, not HTTP wire (for example, CLI). Captures do not enable thinking or recover reasoning a provider did not return. Request options/auth headers are not recorded, recognized nested credential/header fields are redacted, and POSIX files are owner-only. They still contain private source/graph content, have **no automatic expiry**, and require review before sharing and manual deletion when no longer needed. Capture/serialization errors do not fail workers.

For frontend failures, inspect the actual UI, requests, console, and state. A static render alone does not establish that an interaction works.

## Checks

```sh
npm test               # node:test via tsx; injected engines, fixtures, fake transports
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint, including import restrictions
npm run build          # Next production build
```

The suite requires no paid models or real sign-in. Some tests use temporary files, native processes, or local fake endpoints: deterministic does not mean every test is pure or cannot bind a loopback port. Inspect focused-suite setup before running beside a live app.

[Golden fixtures](../tests/fixtures/golden-data/README.md) exercise saved records through production paths. Keep compatibility expectations with intentional format changes; do not hand-edit fixture content to make tests pass. [Standalone skill-reader tests](../tests/skills/README.md) run separately with Python and no app runtime.

Additional runtime gates have prerequisites:

| Check | Prerequisite / purpose |
| --- | --- |
| `node scripts/smoke-provider-runtime.mjs` | Fresh build; traced provider payload/runtime paths with fixtures. Also used during packaging. |
| `node scripts/smoke-web-subscriptions.mjs` | Build, no dev server running; isolated synthetic connection checks, external traffic blocked. Briefly changes/restores a source mtime to exercise reload. |
| Other `scripts/smoke-*.mjs` | Standalone/native renderers, image workers, demo helper, compression, file paths, opening. Read each script and the [release guide](desktop-release.md) before running. |

Run checks proportionate to the change. Offline gates prove exercised contracts, not live entitlements or model-authored lesson quality.
