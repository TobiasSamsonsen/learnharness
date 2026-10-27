# What the owner has to do on the phone

Everything that needs hands, a pen, an unlocked screen or a camera, collected in one place. Everything else is done by Claude over `adb`. Tick a line when it is done and tell Claude what you saw; Claude records the result in [STATUS.md](STATUS.md).

State left on the phone (2026-10-27): Wireless debugging paired and on; **stay awake while charging** is on (`stay_on_while_plugged_in` was 0, so turn it off again in Developer options when you are done); the screen timeout is the original 30 minutes; the debug app `dev.learnharness.android` is installed with its Termux permission granted and a chat open; the phone is unlocked and awake while it charges (Claude never unlocks it).

## M8 (Android shell)

| | Where | What to do | What to tell Claude |
|---|---|---|---|
| [ ] | any time | **Screen-off turn (the real one).** Claude tested the closest thing it can do while the phone stays unlocked: sent a message, put the app in the background for 80 s, came back: the tutor's question was there, complete. A real screen-off needs you: send a message, press the power button right away, wait a minute, unlock. | Was the reply there, complete, with no "reconnecting" state? If not, Claude looks at the wake lock and the SSE reconnect. |
| [ ] | pen | **Sketch by pen in the shell.** The path itself is verified (Claude drew with injected touch, picked an option, submitted: the tutor answered with an "I read:" card, flagged its doubts, and offered "That's not what I wrote"). What needs a pen: write a line of maths with the pen, then touch the page with a finger (it should pan, not draw). | Did the ink follow the pen without lag or stray finger marks? Did the "I read:" card get your handwriting right? |
| [ ] | any time | **A demo.** Claude tried ("show me an interactive demo of a sine wave") but the tutor opens with probe questions, so no demo had appeared after two rounds. Answer the probes in a session and wait for a demo, or ask in teach mode. | Did the demo card render and respond to touch? (Its iframe cannot reach the shell's save bridge, by design; Claude checked that.) |
| [ ] | after `lh update` | **Back button on the phone's own server.** Claude verified the whole sequence against the PC dev server inside the shell (drawer closes; an open Settings menu closes before Settings; Settings closes; with nothing open it leaves the app). The phone's own server is still the pre-M8 build, which has no back hook (back there just goes through page history). After `lh update`, repeat it once in a real lesson: drawer, Settings, a dropdown inside it. | Each press should close only the top layer; one more press with nothing open leaves the app. |
| [ ] | PC browser, then Termux | `main` is pushed (2026-10-27, `01d57c0` at the time). The `android-latest` rebuild did **not** run: dispatching the Android server workflow on your fork returns HTTP 422 "Actions has been disabled for this repository", although the API reports Actions enabled. For a fork that is usually a one-click confirmation on the repo's **Actions** tab ("I understand my workflows, go ahead and enable them"). Click it, run **Actions → Android server (linux-arm64) → Run workflow** on `main` (or `gh workflow run android-server.yml -R TobiasSamsonsen/learnharness --ref main`; note plain `gh` defaults to the upstream repo), wait for it to go green, then in Termux `lh update` and reopen the app. | Did the "Import notes…" pill sit below the status bar (the shell's top inset)? Did back close a drawer? |
| [ ] | sidebar | Delete the four test chats Claude made: "Say hello in one word.", "Write a paragraph of about 120 words on prime numbers.", "Write 150 words on the Fibonacci sequence." and "gShow me an interactive demo…". | — |

## M9 (ink decision gate)

See [m9-plan.md](m9-plan.md) for what each test is for; the numbers go into its result table.

| | What to do | What to tell Claude |
|---|---|---|
| [ ] | The spike build is installed (Claude put it on the phone). Open the **Ink spike** screen: `adb shell am start -n dev.learnharness.android/.InkSpikeActivity` from the PC, or ask Claude to. Nothing for you to install. | — |
| [ ] | **Latency, camera test.** Film the pen tip and the screen together with the camera in 240 fps slow motion; draw fast circles and a long diagonal in (a) Chrome on the app's sketch canvas, (b) the shell's sketch canvas, (c) the Ink spike screen. Three takes each. | The video files (or the frame counts between pen tip and ink tip). `node scripts/ink-latency.mjs frames --fps 240 <counts>` turns counts into milliseconds (Claude can run it). |
| [ ] | **Dense notation.** Write the sheet in the m9 plan (subscripts, a 2×2 matrix, an integral with limits, a fraction inside a root) on the web canvas and on the Ink spike screen. | Which one looked better, and whether the web canvas lost or smeared anything. A screenshot of each. |
| [ ] | **Decision.** Read the numbers Claude put in the m9 table. | Build the native overlay (M10) or keep the web canvas? |

## Decisions Claude prepared for you (no phone needed, but only you can decide)

| | Where | What to decide |
|---|---|---|
| [ ] | [m9-plan.md](m9-plan.md) "Decision rule" | Accept or change the proposed rule for building M10 (about 30 ms or "noticeably worse notation"), once the camera numbers are in. |
| [ ] | [m10-plan.md](m10-plan.md) "Questions for the owner" | Seven questions (bridge shape, opt-in switch, where the pixels are made, tall pages, pen buttons, prediction, fallback). Only needed if M9 says to build the overlay. |
| [ ] | [m11-plan.md](m11-plan.md) "Questions for the owner" | Six questions (how to handle the respawn after a pose, replay size, idle/cap policy, `listChats` cache vs index, whisper RAM, wake lock). Q5 is actionable today on the phone: swap was full (5 MB free) with both GPU whisper servers running; setting `STT_LANGS="nb"` in `~/.lh/config` and `lh restart` frees ~600 MB. |
| [ ] | branch `feat/m11-prep` | Review and merge the M11 prep: the `listChats` cache (Q4 as you chose), two removed re-reads, the benchmark. Then, on the phone after `lh update`, ask Claude to time `GET /api/chats` before/after with a generated test data dir. |
| [ ] | m11-plan.md "Found while starting" | Should the sidebar's "Problem waiting" label work? It never shows today (`pendingProblem` is never computed); a small behaviour change. |
| [ ] | after merging `feat/m11-prep`, CI, `lh update` | **On-demand whisper on the phone.** In Termux: `lh restart`, then `lh status`: `whisper-nb` running, `whisper-en: stopped (starts when asked for)`, `supervisor` running. In the app, dictate once in English: the first piece should wait a few seconds, then `lh status` shows `whisper-en` running; ten idle minutes later it is stopped again. Also check `MemAvailable` and swap before/after (swap was full at 5 MB free). Tell Claude the numbers. |
| [ ] | CI | The workflow's `shellcheck` step must pass on the new `lh` (Claude could not run it locally). |
