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

## Open (design decisions for the owner; nothing below is changed yet)

1. **Colour.** The theme is neutral only: `--primary #e6e6e6`, `--accent #2a2a2a`, no hue anywhere except the destructive red. Primary actions (Submit answer, Send) read as disabled grey-on-grey. The only colour on screen is inside demos.
2. **Touch targets** (CSS px; Android guideline 48, Apple 44). On the home screen every control is under 40: "Import notes…" 28 high, Sources 28, language 28, mic 32, model/effort pills 25, the Teach/Practice toggle 19 (text height), sidebar toggle 36. Drawer: new-session rows 27, "New course" 19, filter tabs 25, search 24.
3. **The question dock covers about two thirds of the screen** during a question (probe card, confidence, thinking box, composer): the transcript is squeezed to a strip while you answer.
4. **Header.** The session title is set large in a serif and truncated ("Teach me how …"); the status labels (PLAN, TEACHING, PROBING) sit crammed against the right edge; the header is about a tenth of the screen.
5. **Contrast and type.** Labels are small (11-12 px) uppercase monospace in mid grey on near-black ("CONFIDENCE set before submitting", "key ↗ not set"); UI chrome is monospace, prose is sans.
6. **Empty home.** A large empty area with a small centred text and an easily missed icon.
7. **Drawer.** Flat list: no type marker (teach / practice), no separators, tiny section headers.
8. **Stats line** under the composer (token count, the two pickers) is tiny.
