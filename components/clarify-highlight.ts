/**
 * The faint tint on the text a margin thread hangs on (owner design, 2026-11-06): every line the learner asked about stays
 * lightly marked, a little stronger while its card is open. Painted with the browser's Custom Highlight API, so the markdown,
 * the formulas and the learner's own selection are never touched; where the API is missing nothing is marked and nothing breaks.
 *
 * Two layers can mark at once (the transcript's and the dock's, each over its own text), and a highlight name holds ONE set of
 * ranges, so each layer registers its ranges here and the sets are merged under the two names.
 */

export const ASK_HIGHLIGHT = "lh-ask";
export const ASK_OPEN_HIGHLIGHT = "lh-ask-open";

/** Below Find's highlights (priority 0, and 1 for the active match): a search result must read over our tint. */
const ASK_PRIORITY = -2;
const ASK_OPEN_PRIORITY = -1;

/** ::highlight() rules live in an injected <style>, not in globals.css, for the reason session-find.tsx gives (the PostCSS
 *  pipeline rejects the pseudo-element). Injected once, on first client mount. */
const STYLE_ID = "lh-ask-style";
export function injectAskStyles(): void {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
::highlight(${ASK_HIGHLIGHT}) { background-color: color-mix(in oklab, var(--primary) 14%, transparent); }
::highlight(${ASK_OPEN_HIGHLIGHT}) { background-color: color-mix(in oklab, var(--primary) 30%, transparent); }`;
	document.head.appendChild(style);
}

const layers = new Map<string, { all: readonly Range[]; open: readonly Range[] }>();

function supported(): boolean {
	return typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight !== "undefined";
}

function publish(): void {
	if (!supported()) return;
	if (layers.size === 0) {
		CSS.highlights.delete(ASK_HIGHLIGHT);
		CSS.highlights.delete(ASK_OPEN_HIGHLIGHT);
		return;
	}
	const all = new Highlight();
	all.priority = ASK_PRIORITY;
	const open = new Highlight();
	open.priority = ASK_OPEN_PRIORITY;
	for (const layer of layers.values()) {
		for (const range of layer.all) all.add(range);
		for (const range of layer.open) open.add(range);
	}
	CSS.highlights.set(ASK_HIGHLIGHT, all);
	CSS.highlights.set(ASK_OPEN_HIGHLIGHT, open);
}

/** A layer's current ranges: every thread's lines (`all`) and, of those, the open thread's (`open`). Replaces its last call. */
export function setLayerHighlights(layerId: string, all: readonly Range[], open: readonly Range[]): void {
	layers.set(layerId, { all, open });
	publish();
}

/** The layer is gone: its marks go with it. */
export function clearLayerHighlights(layerId: string): void {
	if (layers.delete(layerId)) publish();
}
