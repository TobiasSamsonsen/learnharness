# Android plan — status (2026-10-26)

Plan: [plan.md](plan.md). Branch `feat/sketch-answers` holds M1 work in progress, by Claude for the owner.

## Being worked on now: M1 (sketch answers, desktop vertical slice), in its final checks. Don't start M1 in parallel.

### M1 decisions made after the plan
- **Strokes on the wire, server renders.** Producers send vector strokes (`SketchPayload`). Core plans the pages; resvg renders PNG for the model and SVG for the UI.
- `perfect-freehand@1.2.3`, pinned exactly. The same outline options are used client and server (`sketchStrokeOptions`).
- **Limits:** 3,000 strokes · 250k points · 4 MB per sketch. At most 6 pages, page long edge ≤ 2000 px.
- **Kept practice page:** a dock submit with unsent ink shows a removable "Sketch attached" chip. A re-submit with no new ink sends only a reference. After a reload, restore the submitted strokes (server) plus unsent ink (localStorage). This lands in M3.
- **Sketch view keys:** Ctrl/⌘+Enter submits, Esc closes (cancels dictation first), Ctrl+Z / Ctrl+Shift+Z undo and redo. Plain Enter does nothing.
- **Unsent ink (M1):** closing the sketch view keeps the ink in memory for that question or problem (`components/sketch/ink-memory.ts`); a submit from the canvas clears it. A plain text submit from the dock leaves the ink alone (the "Sketch attached" chip is M3).

### M1 status: implemented, tests green; two checks left
- Core: `contracts/sketch.ts`, `sketch.ts` (+ `sketchStrokePath`, shared by the canvas and the server render), `input-events.ts` (optional `sketch` on answer/thinking, 400 on a bad payload, the server derives the ref), `question-core.ts`, `native-messages.ts`, `compaction.ts` (sketch pages counted once; `[image]` in summaries).
- Server: `src/server/sketches.ts` (exported), `chat-handler.ts` (pages stored before the hold-back save and the write-ahead; a store failure is a 500 and the record is untouched), `teacher-agent.ts` (`sketchImages` → `convertToLlm`), route `GET /api/chats/[id]/sketches/[sketchId]/[page]?format=svg|png`.
- UI: `components/sketch/*` (view, canvas, ink memory, thumbnail), "Open in sketch" in the practice dock and text-mode question dock (shown only when the session model's catalog entry has image input), thumbnails in `ThinkingCard`/`AnsweredCard`, plumbing through `session-core.ts`/`session.ts`/`chat.tsx`/`stats-bar.tsx`.
- Tests: `tests/sketch-contract.test.ts`; additions in `practice-flow`, `session-core`, `render-practice-surface`, `claude-code-live` (the fake CLI now logs block types: an answer's page rides the held MCP reply and a submission's page the learner message, on the same process). `npm run typecheck`, `npm run lint` clean; `npm test` 2329/2339, the 10 failures are the known Windows ones.
- **Live check passed (2026-10-26):** the real `claude` CLI (2.1.310, `claude-haiku-5-5`) passes an MCP image result through. A held tool call answered with a resvg-rendered sketch page (a drawn triangle) got the reply "A triangle." (~1.9k tokens).
- **Review fixes (`/code-review high`, 2026-10-26):** one request attaches only the newest 20 sketch pages (`SKETCH_MAX_REQUEST_PAGES`; older pages become text stubs — owner's pick, replaced by M2's elision); pages are estimated at ⌈w/28⌉×⌈h/28⌉; the ink is cleared only after the server accepts the sketch (`send` resolves to accepted); PNGs go through `providerSafePng`; optimistic absorption compares a sketch by id; thumbnails retry with backoff for ~2 min; an open sketch view closes when the model loses image input; the canvas reads layout once per stroke and draws once per frame; keyboard-focused buttons keep Enter. `tests/sketch-view.test.tsx` covers the ink and key rules.
- **Known cost of the 20-page window:** once a chat passes 20 pages, each new sketch turns one older page into a stub. That changes the earlier history, so Claude Code starts a fresh process and replays the transcript on that turn. Dropping pages in batches would cut the respawns; M2's elision fixes it properly.
- **Left:** a manual pen/mouse run in the app.

### Not started (free to pick up): M0 (phone spike), M4, M5, M6. M2/M3 depend on M1.
