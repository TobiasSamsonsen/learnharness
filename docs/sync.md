# GitHub sync

Keeps one learner's data in step across devices through a **private GitHub
repo** the learner creates. Fork addition, 2026-11-02. Owner decisions are
marked (owner).

## Using it

1. Create an empty **private** repo on GitHub.
2. Create a fine-grained token limited to that repo, with **Contents: read
   and write**.
3. Settings → Sync: enter `owner/repo`, paste the token (stored in
   `auth.json` as `LH_GITHUB_SYNC_TOKEN`, never read back), press **Sync now**.

Clear the repo or remove the token to turn sync off. A **public** repo is
refused: chats are stored readable, not encrypted (owner).

## When it runs

`instrumentation.ts` starts one loop per server process (Electron and the
Android guest run the same standalone server). `LH_SYNC=0` switches the loop
off; it never starts under test. The manual button always works.

- on start: a full round (pull, then push);
- every 5 minutes: a round;
- 30 seconds after the synced files stop changing: a round (a cheap
  path+size+mtime fingerprint, `quickFingerprint`, is polled every 10 s);
- a bad token, a missing repo or a public repo stops the automatic rounds
  until the configuration changes; a rate limit pauses them until GitHub says
  it lifts.

## What travels

Repo paths mirror the data dir. Scope is `syncScope` in `src/core/sync-plan.ts`.

| Travels | Notes |
|---|---|
| `chats/*.json` | |
| `courses/*.json` | held back while `status` is `drafting` |
| `graph/{nodes,chains,skills,coverage}.jsonl`, `positions.json`, `render-settings.json`, `format.json` | not `sources.json`, `source-organization.json`, `sessions.jsonl`: their ids hash a device-local file path (owner) |
| `sketches/<chat>/<sk>/strokes.json` and `N.svg` | a drawn page's `N.png` is a render of its SVG and does not travel; a photo sketch's does (owner). A synced sketch's PNG is re-rendered on first use (`ensureSketchPngs`) |
| `settings.json`, portable part only | `models`, `agent`, `graph`, `compaction`, `general.language/pace`. Custom provider, Claude Code, dictation, appearance, notices and unknown keys stay on the device (owner) |
| `prompts/**/*.md` | |
| `materials/<chat>/index.json` (minus items still `reading`), `materials/<chat>/<id>/content.md` | original source files do not travel; the other device shows "original on another device" (owner) |

Never: `models/`, `jobs/`, `auth.json`, credentials, `debug/`, `sync/`.

## How a round works

`src/server/sync/engine.ts`, over `src/core/sync-plan.ts` and
`src/core/sync-merge.ts`.

1. **Read** (async): the repo tip and tree, this device's files as git blob
   SHAs (`scanLocal`), the manifest from the last completed round
   (`data/sync/manifest.json`: the base), and the blobs the plan needs.
2. **Plan**: a three-way compare of base / local / remote SHAs per file. No
   clocks. Both changed means a merge; a delete against an edit is a
   `conflict-delete`.
3. **Apply** (one synchronous section, no `await`): each touched file is
   re-read and must still match step 1, else it is skipped for this round.
   The stores write with synchronous fs in the same thread, so nothing can
   interleave. A chat mid-turn or mid-compaction (`isRepoPathBusy`) is also
   skipped. Writes are tmp + rename.
4. **Push**: one commit through the Git Data API (text inline in the tree,
   binary through the blob endpoint). The branch moving mid-push restarts the
   round; it is never forced.
5. **Remember**: the manifest records every file's SHA and the tip.

An empty repo gets a `.learnharness-sync` marker commit first (the Git Data
API refuses an empty repository).

## Merge rules (`mergeFile`)

Newest wins and **the loser is kept**: saved under
`data/sync/conflicts/<time>/<path with / as __>` (owner). A delete against an
edit keeps the edit (owner).

- **Chats**: messages are append-only, so one copy is normally a prefix of the
  other: take the longer. Continued on both devices: keep the newer whole.
  `turns`, `extractions`, `clarifyThreads` union by id; `title`, `settings`,
  `tree` take whichever side changed since the base.
- **Courses**: `title`, `language`, `note` per field; `status/skills/draft/error`
  as one unit (an approval sets all four); `drafts` union.
- **Graph ledgers**: line-level three-way against the base. A base line
  survives only if both sides keep it; an id one side deleted stays deleted;
  lines are grouped by id, oldest `createdAt` first. `coverage` keeps the
  later row per chat; `positions` the newer file; `format` the higher version.
- **Settings / render settings**: key by key, one level into nested objects.
- **Materials**: by id; further-along status wins (ready > error > reading).
- **Anything else**: the preferred side, the other kept. "Preferred" is the
  side whose file time is not older than the repo tip's commit time.

With no base (a first sync, or its blob is gone) every rule falls back to a
union: nothing is discarded, but a deletion made before the first sync can
come back.

## Limits and known gaps

- Text and web materials have no original on the other device either (their
  source file is the text).
- Sketch SVGs are large (about 0.4 MB each); they dominate repo growth.
  GitHub recommends repos under 1 GB; history never shrinks.
- Two devices extracting the same chat independently mint different node ids
  and the graph keeps both.
- Listing needs one recursive tree request; a repo too large for it fails with
  a clear message.
- Verified live (2026-11-03) against a real private repo with two simulated
  devices: the empty-repo bootstrap, a 658-file first push (chained trees),
  byte-exact binary files, pull, device-only settings left alone, a chat
  continued on both devices (newer kept, loser saved, devices converge),
  delete propagation, delete-vs-edit, an idle round making no commit, and the
  refusal of a public repo. The production standalone build starts the loop at
  boot. On a Galaxy Tab S10+ the engine and service ran inside the app's proot
  guest (Node 26.12.1, linux/arm64) against an in-memory repo; everything passed,
  as did an anonymous TLS read of api.github.com. On a Pixel 7 Pro (test device,
  2026-11-03) a locally assembled linux-arm64 standalone server was run in the
  guest on scratch data: with a repo in settings.json and a token in the
  environment, the boot hook started a round by itself, which pulled 656 files
  from the real test repo, merged settings, and pushed 6 files (3 chats and a
  binary photo page, byte-exact in the repo) as one commit. A fake token ended
  the same round with the "token refused" error. The guest's `resolv.conf` is
  written by the app at server start, so a stale one (a different network)
  breaks every outbound call until the app restarts the server.

## Files

`src/core/sync-plan.ts` (scope, three-way), `src/core/sync-merge.ts` (merge
rules, portable settings/materials), `src/core/sync-status.ts` (status shape
for the UI), `src/server/sync/{github,local,engine,service}.ts`,
`src/server/sync-service.ts` (wiring), `app/api/sync/**`,
`components/settings/sync-{section,client}.ts*`, `instrumentation.ts`.
