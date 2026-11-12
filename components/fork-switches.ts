/**
 * Upstream UI the fork keeps in the code but does not show (owner, 2026-11-12).
 *
 * `upstreamSelectionTools`: upstream v0.6.0's selection toolbar on tutor text (Cite and the side question), the "?" side
 * conversation button after each teaching segment, the side companion (panel and floating), its Mod+J shortcut and the
 * "Side questions" model row in Settings. Off: marking text shows the fork's own "Ask about this" pill everywhere, as
 * before that merge (components/ask-selection.tsx). Upstream's files are untouched, so its merges stay easy and its
 * tests keep running; side threads and citation chips already saved in a chat stay in the record.
 *
 * A holder, not a bare constant, so a test can turn it on for one case (the fork-extensions.ts pattern).
 */
export const upstreamSelectionTools = { current: false };

/** A keyboard action that is not offered while its feature is off: not claimed, not listed, not rebindable. */
export function isHiddenKeyAction(id: string): boolean {
	return id === "toggle-question-thread" && !upstreamSelectionTools.current;
}
