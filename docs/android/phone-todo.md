# What the owner has to do on the phone

Everything that needs hands, a pen, an unlocked screen or a camera, collected in one place. Everything else is done by Claude over `adb`. Tick a line when it is done and tell Claude what you saw; Claude records the result in [STATUS.md](STATUS.md).

State left on the phone (2026-10-27): Wireless debugging paired and on; **stay awake while charging** is on (`stay_on_while_plugged_in` was 0, so turn it off again in Developer options when you are done); the screen timeout is the original 30 minutes; the debug app `dev.learnharness.android` is installed with its Termux permission granted; the phone is locked (Claude does not unlock it).

## M8 (Android shell)

| | Where | What to do | What to tell Claude |
|---|---|---|---|
| [ ] | any time, phone unlocked | **Screen-off turn.** Open the learnharness app, send a message (a long answer is better: "Write 150 words about prime numbers"), press the power button right away, wait a minute, unlock. | Was the reply there, complete, with no "reconnecting" state? If not, Claude looks at the wake lock and the SSE reconnect. |
| [ ] | pen | **Sketch by pen in the shell.** Start a practice session, tap "Open in sketch", write a line of maths with the pen (and a finger on the page to see that it pans, not draws), submit. | Did the ink follow the pen without lag or stray finger marks? Did Claude's reply start with "Claude read: …"? |
| [ ] | any time | **A demo.** Ask for a lesson on something visual (e.g. "show me an interactive demo of a sine wave"). | Did the demo card render and respond to touch? (Its iframe cannot reach the shell's save bridge, by design.) |
| [ ] | any time | **Back button** in a real lesson: open the drawer, open Settings, open a dropdown inside it; press back after each. | Each press should close only the top layer; one more press with nothing open leaves the app. |
| [ ] | Termux | After the merge to `main` and the CI run: `lh update`, then reopen the app. | Did the "Import notes…" pill sit below the status bar (the shell's top inset)? |
| [ ] | sidebar | Delete the test chat "Say hello in one word." (and the paragraph-about-primes chat if it exists). | — |

## M9 (ink decision gate)

See [m9-plan.md](m9-plan.md) for what each test is for; the numbers go into its result table.

| | What to do | What to tell Claude |
|---|---|---|
| [ ] | The spike build is installed (Claude put it on the phone). Open the **Ink spike** screen: `adb shell am start -n dev.learnharness.android/.InkSpikeActivity` from the PC, or ask Claude to. Nothing for you to install. | — |
| [ ] | **Latency, camera test.** Film the pen tip and the screen together with the camera in 240 fps slow motion; draw fast circles and a long diagonal in (a) Chrome on the app's sketch canvas, (b) the shell's sketch canvas, (c) the Ink spike screen. Three takes each. | The video files (or the frame counts between pen tip and ink tip). `node scripts/ink-latency.mjs frames --fps 240 <counts>` turns counts into milliseconds (Claude can run it). |
| [ ] | **Dense notation.** Write the sheet in the m9 plan (subscripts, a 2×2 matrix, an integral with limits, a fraction inside a root) on the web canvas and on the Ink spike screen. | Which one looked better, and whether the web canvas lost or smeared anything. A screenshot of each. |
| [ ] | **Decision.** Read the numbers Claude put in the m9 table. | Build the native overlay (M10) or keep the web canvas? |
