# M5 plan: tablet/touch layout pass

Status: **approved and implemented** (2026-10-26); see STATUS.md. Parent: [plan.md](plan.md) §7 (M5). Track A, no device needed.

## Owner decisions (this session)

| Topic | Decision |
|---|---|
| Sidebar | Below **1024 px** it is a **modal overlay drawer** with a dimmed backdrop; tapping the backdrop or a session closes it; default closed at that width. The stored open/closed preference is not touched. Electron keeps its current auto-close at 928 |
| Enter key | `matchMedia('(pointer: coarse)')` (primary pointer, live). On coarse pointers plain Enter inserts a newline and the send button submits. Ctrl/⌘+Enter still sends. A tablet with a keyboard attached still counts as coarse |
| Tooltips | **Long-press shows the label** (~500 ms, touch only, auto-hides after ~2 s, release does not activate the button). A normal tap just activates. Implemented once inside `Hint` |
| Skill map | Inline: one finger scrolls the page, **two fingers pan + pinch** the map. Expanded: one finger pans, two pinch |
| Long-press menus | **Rely on the native `contextmenu` that Android fires on long-press, and harden it.** No synthesized long-press; iOS/Safari out of scope |
| Settings | **Full-screen below 1024 px**, nav becomes a horizontally scrollable tab strip under the header |
| Safe area | Export `viewport` with `viewportFit: 'cover'` now and use `env(safe-area-inset-*)` on the edge UI |
| Touch hint | The "↵ submits · ⇧↵ newline" hint under the thinking fields is hidden on coarse pointers (asked during implementation) |
| Pinch scope | One shared pinch/pan helper next to `pan-zoom.ts`, used by the skill map, the plan popup (`plan-block.tsx`) and the session overlay (`session-overlay.tsx`). The graph view keeps d3-zoom's own pinch |

## Applied as the plan says (no choice left; shout if you disagree)

- **Hover-only affordances:** the only ones are the copy buttons in `md-blocks.tsx` (2) and `figures/figure-block.tsx` (1), `opacity-0 … group-hover/md:opacity-100`. Under `(hover: none)` they are always visible.
- **Enter-everywhere hook** (`useEnterSubmits`, window-level Enter outside a typing surface) is unchanged. It fires only when a key event exists, i.e. a hardware keyboard. The sketch view's keys (Ctrl/⌘+Enter submits, plain Enter does nothing) are unchanged.
- The 1024 px breakpoint is one shared constant used by the sidebar and the settings dialog.
- Electron behaviour is unchanged (`IS_ELECTRON` branch in `sidebar.tsx`).

## Findings from the audit (what the code does today)

- **Sidebar** (`components/sidebar.tsx`): inline `w-72` column in a `flex h-dvh` row, no backdrop. `narrow` auto-close exists only under `IS_ELECTRON` (L131-137). A plain narrow tab squeezes the page.
- **Enter:** plain Enter sends in `composer.tsx:142`, `home.tsx:274`, `practice-dock.tsx:208`, `question-dock.tsx:899` and `:929`, and `reading-thinking.tsx:83`. Shift+Enter is the newline.
- **Tooltips:** `components/ui/hint.tsx` wraps Radix `Tooltip`, which never opens on touch.
- **Skill map** (`skill-map.tsx`): the viewport is `touch-none` (L199), so a finger on it cannot scroll the page; there is no pinch.
- **Plan popup / session overlay:** pointer-drag pan plus wheel zoom; no pinch.
- **Context menus:** `sidebar.tsx` rows (`onContextMenu`, L283-306, L554-584) and `graph-canvas.ts:1063`. The sidebar menu closes on any outside `pointerdown`; I have to check that a long-press release does not click the row or instantly dismiss the menu.
- **Settings dialog:** fixed `h-[620px] w-[920px] max-w-[90vw]` modal with a `w-44` side nav (`settings-dialog.tsx:288, 326`).
- **Safe area:** no `viewport` export and no `env(safe-area-inset-*)` anywhere. Next's default viewport meta applies.
- The chat column, dock (`max-w-[46rem]`) and home are already fluid, with no breakpoints (8 responsive classes in the whole of `components/`).

## Design

### 1. Sidebar drawer
- A `useNarrowViewport()` hook (`matchMedia('(max-width: 1023.98px)')`, SSR-safe: starts `false`, set after mount like `mounted` today). `SidebarContext` gains `overlay: boolean`.
- Overlay mode: the `<aside>` is `fixed inset-y-0 left-0 z-40`, a sibling backdrop (`bg-background/60`) closes it; navigating to a session or any page closes it. It starts closed in overlay mode, and open/close in overlay mode does **not** write `lh:sidebar-open`.
- Above 1024 px: unchanged (inline, stored preference). Electron: unchanged.
- The content column no longer reserves 288 px in overlay mode; the `SidebarToggle` hamburger is shown whenever the drawer is closed.
- Safe-area: the drawer pads `env(safe-area-inset-left/top/bottom)`.

### 2. Enter on coarse pointers
- `usePrefersNewlineEnter()` (`components/coarse-pointer.ts`, a pure `matchMedia` subscription): `true` on `(pointer: coarse)`.
- The six Enter handlers above gain one guard: when coarse, plain Enter falls through to the textarea default (newline); Ctrl/⌘+Enter still calls `act()`. The send button already submits (`composer.tsx` / dock buttons).
- Shared pure helper `enterSubmits(e, coarse)` in `src/core` or `components/enter-submits.ts` so the six sites do not drift, and pinned by a table test.

### 3. Hover-only affordances
- The 3 copy buttons get `[@media(hover:none)]:opacity-100`.

### 4. Long-press tooltips (`Hint`)
- On `pointerType === "touch"`: a 500 ms timer on `pointerdown` opens a controlled tooltip (`open` state) and arms a "swallow the next click" flag so the release does not activate the button; `pointermove` beyond a small slop, `pointerup` before the timer, `pointercancel` cancel it; auto-hide after ~2 s.
- Mouse/pen paths are untouched (Radix hover/focus as today). Controlled `open` merges with Radix's `onOpenChange` so the mouse still works.
- Must not break `tests/tooltip-mechanism.test.tsx`.

### 5. Skill map, plan popup, session overlay: touch gestures
- New pure `components/pointer-gestures.ts` (next to `pan-zoom.ts`): tracks active pointers; one pointer → pan delta; two → pan by the centroid delta + zoom by the distance ratio about the centroid, feeding the existing `zoomedGraphView`.
- Skill map inline: `touch-action: pan-y` on the viewport so one-finger vertical drags scroll the page; pointer events from a **second** finger switch the viewport into gesture mode (two fingers pan + pinch). Expanded: `touch-action: none` (as now), one finger pans.
- The hint text under the map changes on `(hover:none)`: "Two fingers to pan and pinch".
- Plan popup and session overlay: add the same helper to their existing `startDrag` path.
- **Risk to verify:** with `touch-action: pan-y` Chrome sends `pointercancel` when it claims a vertical pan; the helper must treat a cancel as "end", and a second finger down must still be deliverable. **Result:** pointer events alone do not hold a two-finger vertical drag, so the hook also adds a non-passive `touchmove` listener that prevents the default once two fingers are down. Verified through CDP touch input (see STATUS.md).

### 6. Long-press menus
- Sidebar rows: the `contextmenu` handler already calls `preventDefault`. Harden: (a) the post-long-press `click` on the row is swallowed (a ~600 ms "menu just opened" guard), (b) the outside-`pointerdown` dismiss ignores the opening gesture, (c) menu items are ≥ 44 px tall on `(pointer: coarse)`.
- `graph-canvas.ts` `onContextMenu`: same guard against the release click/drag after a long-press.
- No new gesture code.

### 7. Settings dialog
- Below 1024 px: `fixed inset-0`, no border/rounding, header and content padded with safe-area insets; the nav becomes `flex overflow-x-auto` tabs (`border-b`, no `border-r`, no fixed `w-44`); content `min-h-0 flex-1`. Above 1024 px: unchanged. `h-15` header stays.

### 8. Safe area
- `app/layout.tsx`: `export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" }` (checked against `node_modules/next/dist/docs/` before writing, per AGENTS.md).
- A single `--lh-safe-top/right/bottom/left: env(safe-area-inset-*, 0px)` set in `globals.css`; edge UI uses those vars: the sidebar drawer, composer/dock bottom padding (`chat.tsx` dock `pb-5`, `home.tsx`, `new-session.tsx`), sticky headers (`course-page.tsx`, chat/home top bars), the expanded skill map and plan/session overlays (`fixed inset-x-0 bottom-0 top-13`), the settings full-screen, the sketch view's full-screen root.
- No effect on desktop (all zero).

## Tests

- `tests/enter-submits.test.*`: the pure helper table (coarse × shift × ctrl × meta × key).
- `tests/pointer-gestures.test.ts`: pan, pinch about the centroid, cancel, a second pointer joining/leaving, clamp via `zoomedGraphView`.
- Render tests (linkedom pattern, the repo's convention): sidebar overlay mode (backdrop closes, navigation closes, no write to `lh:sidebar-open`), settings full-screen class switch + tab strip, `Hint` long-press (timer, swallowed click, cancel on move), skill-map `touch-action` per mode, copy-button visibility class.
- `npm run typecheck`, `npm run lint`, `npm test` (10 known Windows failures).

## Verification (honest limits)

- The owner has no touch screen or pen (STATUS.md, M3). Real-touch behaviour is therefore verified by **Chrome device emulation (touch events on, `pointer: coarse`)** and the render tests; there is no real-finger test until the tablet exists. I will say that in STATUS.md, as for M3's pen test.
- Emulation covers: 768×1024 portrait, 1024×768 and 1280×800 landscape, a 412×915 phone check as a floor (phone layout is a stated "later" item, so it only has to not break).

## Order of work

1. Branch `feat/tablet-layout` from `main`.
2. `useNarrowViewport` + `coarse-pointer` hooks, `Enter` helper + the six handlers + tests.
3. Sidebar drawer + tests.
4. `Hint` long-press, copy-button visibility + tests.
5. `pointer-gestures.ts` + skill map, plan popup, session overlay + tests.
6. Long-press menu hardening.
7. Settings full-screen + tab strip.
8. `viewport` export + safe-area vars + edge UI.
9. Emulation pass in Chrome at the sizes above; fix what it shows.
10. STATUS.md section, merge.

## Questions still open

None.
