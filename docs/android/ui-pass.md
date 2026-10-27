# Phone UI pass (2026-10-27)

Goal (owner): improve the UI on mobile so it is usable and decent. Findings from the Pixel 7 Pro (430 CSS px wide, the shell with the dev server): home, drawer, Settings, a probe lesson with its question dock, a teaching lesson with the demo card, the sketch view, plus an automatic audit of every control's size and position. Screenshots were read by Claude, not measured with a design tool.

## Fixed (objective bugs, 3b971a5)

| Finding | Fix |
|---|---|
| The tooltip chip (e.g. on "Sources") sat flush against, and past, the screen edge | 8 px collision padding, max width = screen |
| A long-press on a control selected its label and showed Android's selection handles | `user-select: none` + no touch callout on controls for coarse pointers |
| The model pill wrapped its name over two lines ("claude-sonnet-" / "5") | `whitespace-nowrap` |
| Settings' tab strip showed a heavy scrollbar | hidden on phones; the cut-off last tab is the cue |
| A React hydration warning ("1 Issue" badge in dev): the shell injects `--lh-safe-*` onto `<html>` | `suppressHydrationWarning` on `<html>` only |

## Status after the pass (verified in headless Chrome at 430 px with touch emulation, `pointer: coarse` true, plus the earlier checks on the phone)

| # | Finding | State |
|---|---|---|
| 1 | Colour: a neutral theme with no hue | **Done.** Owner brief (warm, a contrast to dopamine apps, "locked in"): warm charcoal `#151210`, cream text, one muted brass accent `#E0B45A` through the existing `--primary` token (buttons, selected option, links, focus, plan icon). The Android shell's own background follows. |
| 2 | Touch targets under 40 px | **Done.** `.lh-touch` (40 px floor, touch screens only) on the composer controls, the model pill, the Teach/Practice switch, the sidebar toggle, the drawer's header buttons, new-session rows, filter tabs, search, New course, Settings and Import notes. Audit on home and the drawer: 0 controls under 40 px (the model popup's search field is 34). |
| 3 | The question dock covers two thirds of the screen | **Left as it is, by design:** the dock IS the question (statement, options, confidence), the page reserves scroll room under it (`dock-spacer`), and the transcript above stays scrollable. At 932 px it is 64 % of the screen. A compact mode would be a new feature, not a fix. |
| 4 | Header crowded | **Done.** The title is 20 px on phones (30 px from `sm` up); the header is 60 px (6 % of the screen); the status labels fit. |
| 5 | Contrast of small labels | **Done by the palette.** Muted text is 6.5:1 on the page; an audit of every text under 18 px on home and a lesson finds none below 4.5:1 except the disabled Submit button (disabled controls are exempt). |
| 6 | Empty home | **Left as it is:** a quiet empty state above the composer; the brass send button is the one point of colour. |
| 7 | Drawer flat | **Left as it is:** readable, tall rows, touch-sized. A per-session type marker would be a new feature. |
| 8 | Stats line | **Done.** The model and effort are one pill ("model · effort"), the effort is changed inside its popup, and the row is one line. |
