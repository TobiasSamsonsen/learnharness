/**
 * Empty-graph chrome pins (empty-graph chrome wave, owner 2026-09-25):
 * Import Notes renders ALWAYS — the one action that works on an empty
 * graph, the entry point itself; search + settings render only when the
 * snapshot has nodes (dead controls are lies — the honesty principle).
 * GraphChromeRow is the pure seam (the DeleteNodeBody pattern): SSR of
 * both states pins the ruling. Fetches don't run under renderToStaticMarkup
 * (effects never fire), so these pins exercise the component directly.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";
import { GraphChromeRow, GraphView } from "../components/graph-view.tsx";
import type { GraphRenderSettings } from "../components/graph-canvas.ts";
import { ServerEventsProvider } from "../components/server-events.tsx";

/** Ref doubles — the SSR harness never attaches them. */
const ref = { current: null };

const PROPS = {
	query: "",
	onQuery: () => {},
	noMatch: false,
	importing: false,
	searchInputRef: ref,
	onImportFiles: () => {},
	settings: {} as GraphRenderSettings,
	changeSettings: () => {},
	onOpenChains: () => {},
};

describe("GraphChromeRow — the empty-graph ruling (owner, 2026-09-25)", () => {
	it("EMPTY graph: Import and source inventory render; canvas search/settings stay absent", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: true }));
		assert.ok(html.includes('data-testid="import-notes"'));
		assert.ok(html.includes("Extract files…"));
		assert.ok(html.includes("lucide-waypoints"));
		assert.ok(!html.includes("lucide-upload"));
		assert.ok(!html.includes("Search nodes…"), "search is a lie on an empty graph");
		// the settings gear is the lucide-settings svg (tooltip wave: its old
		// native title is gone — the styled tooltip carries the label now)
		assert.ok(!html.includes("lucide-settings"), "settings is a lie on an empty graph");
		assert.ok(html.includes('data-testid="open-chain-table"'), "source inventory includes chats/files without graph nodes");
		assert.equal(html.split("graph-chrome-fade-in").length - 1, 1, "only the inventory button has the appearance animation");
	});

	it("empty graph uses the same session-first lead and secondary material guidance as home", () => {
		const html = renderToStaticMarkup(createElement(ServerEventsProvider, { children: createElement(GraphView, {}) }));
		assert.ok(html.includes("<p>Start a session to begin learning.</p>"));
		assert.ok(html.includes("Attach your material with the paperclip or drag and drop.</p>"));
		assert.ok(!html.includes("import notes to build"));
	});

	it("POPULATED graph: all four render, the gated trio carries the fade", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: false }));
		assert.ok(html.includes('data-testid="import-notes"'));
		assert.ok(html.includes("Search nodes…"));
		assert.ok(html.includes("lucide-settings"), "the settings gear renders");
		assert.ok(html.includes('data-testid="open-chain-table"'), "the chains entry renders");
		// the appear-once fade rides exactly the three gated controls, never Import Notes
		assert.equal(html.split("graph-chrome-fade-in").length - 1, 3, "three fade carriers: search + chains + settings");
	});

	it("the bar has a narrow form (owner, 2026-11-06): icon-only text buttons that keep their names, and a search that can shrink", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: false }));
		// the names survive the icon-only form as aria-labels, and the visible labels sit in spans the narrow form hides
		assert.match(html, /data-testid="open-chain-table"[^>]*aria-label="Chains"|aria-label="Chains"[^>]*data-testid="open-chain-table"/);
		assert.match(html, /data-testid="import-notes"[^>]*aria-label="Extract files…"|aria-label="Extract files…"[^>]*data-testid="import-notes"/);
		assert.equal(html.split('class="@max-[34rem]:hidden"').length - 1, 2, "both labels hide when the bar's area is narrow");
		assert.ok(html.includes("@max-[34rem]:w-7"), "the buttons turn into squares");
		// the search container gives way (a flex basis, not a definite width: that counts as its minimum size and ran off the screen)
		assert.ok(/class="graph-chrome-fade-in min-w-0 shrink basis-56 /.test(html));
		assert.equal(/class="graph-chrome-fade-in [^"]*\bw-56\b/.test(html), false);
		assert.ok(html.includes('class="relative min-w-0"') && html.includes("h-7 w-full min-w-0"), "the field can shrink inside it");
	});

	it("the Extract button is the same 28px as its neighbours: no touch-size growth (lh-touch made it 44px beside 28px)", () => {
		for (const isEmpty of [true, false]) {
			const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty }));
			assert.equal(html.includes("lh-touch"), false, `no lh-touch in the bar (isEmpty=${isEmpty})`);
		}
	});

	it("the no-match note renders only when the wrapper says so (its truth stays upstream)", () => {
		const html = renderToStaticMarkup(
			createElement(GraphChromeRow, { ...PROPS, isEmpty: false, query: "zzz", noMatch: true }),
		);
		assert.ok(html.includes("No matching nodes."));
		const quiet = renderToStaticMarkup(
			createElement(GraphChromeRow, { ...PROPS, isEmpty: false, query: "zzz", noMatch: false }),
		);
		assert.ok(!quiet.includes("No matching nodes."));
	});
});