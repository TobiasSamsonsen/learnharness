/**
 * The graph bar's narrow form (owner, 2026-11-06: with a filled graph the bar ran off a phone's left edge, the search box under
 * the sidebar toggle). The bar's own area is a width container (graph-view.tsx, `@container`); below 34rem of it the text
 * buttons (Chains, Extract files…) become icon-only squares and the search field keeps the room that is left. Outside such a
 * container (another host, a test render) the query never matches, so the labels simply stay.
 *
 * The class names are literal strings on purpose: Tailwind finds them by scanning the source.
 */

/** On the button: a square (the 28px inner height) instead of a padded label. */
export const COMPACT_BUTTON = "@max-[34rem]:w-7 @max-[34rem]:justify-center @max-[34rem]:gap-0 @max-[34rem]:px-0";

/** On the label span: gone when narrow (the button's aria-label carries the name). */
export const COMPACT_LABEL = "@max-[34rem]:hidden";
