# Android plan — status (2026-10-26)

Plan: [plan.md](plan.md). Branch `feat/sketch-answers` holds M1 work in progress, by Claude for the owner.

## Being worked on now: M1 (sketch answers, desktop vertical slice). Don't start M1 in parallel.

### M1 decisions made after the plan
- **Strokes on the wire, server renders.** Producers send vector strokes (`SketchPayload`). Core plans the pages; resvg renders PNG for the model and SVG for the UI.
- `perfect-freehand@1.2.3`, pinned exactly. The same outline options are used client and server (`sketchStrokeOptions`).
- **Limits:** 3,000 strokes · 250k points · 4 MB per sketch. At most 6 pages, page long edge ≤ 2000 px.
- **Kept practice page:** a dock submit with unsent ink shows a removable "Sketch attached" chip. A re-submit with no new ink sends only a reference. After a reload, restore the submitted strokes (server) plus unsent ink (localStorage). This lands in M3.
- **Sketch view keys:** Ctrl/⌘+Enter submits, Esc closes (cancels dictation first), Ctrl+Z / Ctrl+Shift+Z undo and redo. Plain Enter does nothing.

### Done (uncommitted-quality WIP, NOT typechecked or tested yet)
- `src/core/contracts/sketch.ts`: SketchPayload, SketchStroke, SketchRef.
- `src/core/sketch.ts`: limits, `parseSketchPayload`, `planSketch` (crop, scale, bands), `sketchRefOf`, `sketchLabel`, `newSketchId`.
- `src/core/question-core.ts`: `sketch` on AnswerRequest/QuestionAnswerData, the `dockSubmitGate` `hasSketch` flag, `compactAnswerForModel` writes `sketch` last.
- `src/core/native-messages.ts`: `newThinkingMessage(..., sketch?)`, `toLlmMessages(messages, {sketchImage})` (images ahead of thinking, appended to answer tool results), `sketchOfMessage`.
- `src/core/input-events.ts`: `sketch` on the answer/thinking inputs, validation (400), a server-derived ref.
- `src/core/ports.ts` SketchStore, `src/store/sketches.ts`, `PATHS.sketches`, `stores.sketchStore`, cleanup on chat deletion.
- `src/server/sketches.ts`: `persistInputSketch`, `sketchImagesFor`, `readSketchPage` (not yet exported from the barrel).

### Remaining for M1
1. Export `src/server/sketches.ts` from `src/server/index.ts`.
2. In `chat-handler.ts`, `await persistInputSketch(chatId, input)` after `appends` succeed and before the hold-back save and the write-ahead. Set `agentOpts.sketchImages = sketchImagesFor(chatId)`.
3. `teacher-agent.ts`: add `sketchImages` to `AgentBuildOptions`, and `convertToLlm: (m) => toLlmMessages(m, { sketchImage: opts.sketchImages })`.
4. Route `app/api/chats/[id]/sketches/[sketchId]/[page]/route.ts` (svg/png).
5. `src/core/compaction.ts`: count sketch pages in `estimateMessageTokens`; in `serializeForSummary`, handle array content and write `[image]` instead of base64.
6. UI: `components/sketch/*` (overlay, canvas drawn with `getStroke`/`sketchStrokeOptions`, submit), an "Open in sketch" button in `practice-dock.tsx` and `question-dock.tsx` (text mode), thumbnails in `practice-cards.tsx` ThinkingCard and `answered-card.tsx`, plumbing through `session-core.ts`/`session.ts`/`chat.tsx`. Hide the button when the model lacks image input.
7. Tests (see plan §7 M1), then `npm run typecheck && npm test && npm run lint`, plus the live check that Claude Code passes MCP image results through.

### Not started (free to pick up): M0 (phone spike), M4, M5, M6. M2/M3 depend on M1.
