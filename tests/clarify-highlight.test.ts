import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";

/** The Custom Highlight API in miniature: a registry map and a set-like Highlight with a priority. */
class FakeHighlight extends Set<unknown> {
	priority = 0;
}
const registry = new Map<string, FakeHighlight>();
const g = globalThis as Record<string, unknown>;

function install() {
	registry.clear();
	g.CSS = { highlights: registry };
	g.Highlight = FakeHighlight;
}
function uninstall() {
	delete g.CSS;
	delete g.Highlight;
	delete g.document;
}
afterEach(uninstall);

const { ASK_HIGHLIGHT, ASK_OPEN_HIGHLIGHT, clearLayerHighlights, injectAskStyles, setLayerHighlights } = await import("../components/clarify-highlight.ts");

const range = (name: string) => ({ name }) as unknown as Range;

describe("clarify-highlight — the tint on the text a thread hangs on", () => {
	it("merges the ranges of every layer under the two names, the open ones also in the stronger one", () => {
		install();
		setLayerHighlights("transcript", [range("a"), range("b")], [range("b")]);
		setLayerHighlights("dock", [range("c")], []);
		assert.equal(registry.get(ASK_HIGHLIGHT)!.size, 3);
		assert.equal(registry.get(ASK_OPEN_HIGHLIGHT)!.size, 1);
		clearLayerHighlights("transcript");
		clearLayerHighlights("dock");
	});

	it("a layer's new ranges replace its last ones", () => {
		install();
		setLayerHighlights("l", [range("a"), range("b")], []);
		setLayerHighlights("l", [range("a")], []);
		assert.equal(registry.get(ASK_HIGHLIGHT)!.size, 1);
		clearLayerHighlights("l");
	});

	it("clearing one layer keeps the other's marks; clearing the last removes both names", () => {
		install();
		setLayerHighlights("one", [range("a")], []);
		setLayerHighlights("two", [range("b")], []);
		clearLayerHighlights("one");
		assert.equal(registry.get(ASK_HIGHLIGHT)!.size, 1);
		clearLayerHighlights("two");
		assert.equal(registry.has(ASK_HIGHLIGHT), false);
		assert.equal(registry.has(ASK_OPEN_HIGHLIGHT), false);
	});

	it("paints below Find's highlights (priority 0, active 1), the open thread above the rest", () => {
		install();
		setLayerHighlights("l", [range("a")], [range("a")]);
		const all = registry.get(ASK_HIGHLIGHT)!.priority;
		const open = registry.get(ASK_OPEN_HIGHLIGHT)!.priority;
		assert.ok(all < 0 && open < 0, "below Find");
		assert.ok(open > all, "the open thread over the others");
		clearLayerHighlights("l");
	});

	it("does nothing, and does not throw, where the Highlight API is missing", () => {
		uninstall();
		assert.doesNotThrow(() => {
			setLayerHighlights("l", [range("a")], []);
			clearLayerHighlights("l");
		});
	});

	it("injects its ::highlight rules once, as a <style> (not through globals.css)", () => {
		const { document } = parseHTML("<html><head></head><body></body></html>");
		g.document = document;
		injectAskStyles();
		injectAskStyles();
		const styles = document.querySelectorAll("style#lh-ask-style");
		assert.equal(styles.length, 1);
		assert.ok(styles[0]!.textContent!.includes(`::highlight(${ASK_HIGHLIGHT})`));
		assert.ok(styles[0]!.textContent!.includes(`::highlight(${ASK_OPEN_HIGHLIGHT})`));
	});
});
