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

## Second pass, 2026-10-28: popups on screen, swipes (owner goal, verified on the Pixel 7 Pro)

**Popups.** The Sources popup opened mostly off the left edge of the screen. Cause: the shared `MenuShell` clamped a menu vertically but only pinned one horizontal edge, so a 320 px menu right-aligned to a control near the left edge started at a negative x. Fixes, all pinned by pure tests:

| What | Fix |
|---|---|
| Every `MenuShell` menu (Sources, language, model, session menu, graph node menu, settings menus, setup slot menus) | The menu's measured width is clamped into the screen (8 px floor, a menu wider than the screen is capped to it), and the status-bar and gesture-bar insets the shell reports count as unusable room. Menus that already fit keep their anchor edge. |
| Stats summary popover, coverage-ring popover | A small hook (`use-keep-in-viewport.ts`) shifts them back inside the screen after mount and on resize; both are also capped to the screen width. |
| Practice metadata box | Capped to the room below its trigger (it scrolls inside), keeping the owner's "always below" rule. |
| Keyboard | Opening a menu no longer focuses its text field on touch devices, so the keyboard does not cover the screen the moment a menu opens. |

**Swipes** (the owner chose which: sidebar, docks, row actions; menus are not swipe-dismissed). One recognizer (`swipe.ts`: pending, active or rejected, committed by distance or flick; a vertical scroll is never taken for a sideways swipe) behind one hook (`use-swipe.ts`: touch only, one finger, not on inputs, `data-no-swipe` opts out; the cross-axis `touch-action` is applied to scrolling descendants through `data-swipe-x`/`-y` in `globals.css`, because the browser only reads `touch-action` up to the nearest scroller).

| Gesture | Behavior |
|---|---|
| Sidebar | Swipe left on the open drawer to close it (it follows the finger, then animates). Swipe right from a 24 px strip on the left edge (middle of the screen, 180 px tall) to open it. The shell exempts exactly that strip from Android's back gesture (`setSystemGestureExclusionRects`); the rest of the edge, and the right edge, still go back. A swipe that starts on a row belongs to the row. |
| Session rows | Swipe left to reveal Rename (the existing inline rename) and Delete (the existing confirmation; the swipe never deletes). One row open at a time; a touch elsewhere closes it. |
| Course rows | Same swipe, with new actions behind it: Rename (inline, `PATCH /api/courses/[id]`) and Delete (a confirmation, `DELETE /api/courses/[id]`; the skills stay in the graph). Course rows had no actions before. |
| Question and practice docks | A handle (a small pill, touch devices only) above the dock: swipe down folds the dock to its bar, swipe up (or tap) opens it. A fold made this way stays folded: the transcript's scroll logic no longer re-opens it until the learner opens it or the next question arrives. |

Verified on the phone with synthetic touch swipes through adb: the drawer opens from the edge and closes by swipe, a session row and a course row reveal their actions, Rename starts the inline edit, Delete opens the confirmation and deletes, a real pending question folds and unfolds by its handle and stays folded, the Sources popup and the stats popover sit inside the screen. Not verified: a real finger's feel (thresholds are guesses: 72 px to close, 56 px to open, 38 px per action, 36 px for a dock), the pen or stylus, rotation, and the gesture-exclusion zone against the real system back gesture (adb input does not go through it).
