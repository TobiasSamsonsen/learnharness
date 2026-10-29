/**
 * M5 tablet/touch layout pins that are visible in static markup: the settings
 * dialog's full-screen + tab-strip classes below the 1024px (`lg`) line, the
 * copy corners that stay visible where nothing can hover, and the inline
 * skill map's touch-action (one finger scrolls the page; expanded owns every
 * touch).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyCorner } from "../components/md-blocks.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { SkillMap } from "../components/skill-map.tsx";

describe("settings dialog below 1024px", () => {
	const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);

	it("fills the screen, square and borderless, padded by the safe-area insets", () => {
		const dialog = html.match(/<div[^>]*data-testid="settings-dialog"[^>]*>/)?.[0] ?? "";
		for (const cls of ["max-lg:h-full", "max-lg:w-full", "max-lg:max-w-none", "max-lg:rounded-none", "max-lg:border-0"]) {
			assert.ok(dialog.includes(cls), cls);
		}
		for (const side of ["top", "right", "bottom", "left"]) assert.ok(dialog.includes(`var(--lh-safe-${side})`), side);
	});

	it("keeps the desktop modal above the line", () => {
		assert.match(html, /h-\[620px\][^"]*w-\[920px\]/);
	});

	it("replaces the left nav with a category list (one large row per section) that is hidden on desktop", () => {
		const nav = html.match(/<nav[^>]*data-testid="settings-nav"[^>]*>/)?.[0] ?? "";
		assert.ok(nav.includes("max-lg:hidden"), "the left nav is for desktop");
		const list = html.match(/<nav[^>]*data-testid="settings-list"[^>]*>/)?.[0] ?? "";
		assert.ok(list.includes("lg:hidden"), "the category list is for phones and tablets");
		const rows = [...html.matchAll(/data-testid="settings-list-([^"]+)"/g)].map((m) => m[1]);
		assert.deepEqual(rows, ["keys", "agent", "dictation", "appearance", "graph", "keyboard", "general"]);
		assert.match(html, /min-h-0 flex-1 max-lg:flex-col/, "the body stacks the list over the page");
		assert.ok(html.includes("Updates and default lesson language"), "each row says what is behind it");
	});
});

describe("copy corners where nothing can hover", () => {
	it("stay visible under (hover:none) while still hover-revealed on a mouse", () => {
		const html = renderToStaticMarkup(<CopyCorner label="Copy" getText={() => "x"} />);
		assert.ok(html.includes("opacity-0"), "hidden by default");
		assert.ok(html.includes("[@media(hover:none)]:opacity-100"), "visible without hover");
		assert.ok(html.includes("group-hover/md:opacity-100"), "mouse reveal kept");
	});
});

describe("the inline skill map's touch rule", () => {
	const html = renderToStaticMarkup(
		<SkillMap nodes={[{ id: "a", title: "A" }]} edges={[]} statusOf={() => "upcoming"} focusIds={["a"]} />,
	);

	it("inline: one finger scrolls the page (pan-y), not touch-none", () => {
		const vp = html.match(/<div[^>]*data-testid="skill-map-viewport"[^>]*>/)?.[0] ?? "";
		assert.ok(vp.includes("touch-pan-y"));
		assert.ok(!vp.includes("touch-none"));
	});

	it("names both gestures: the mouse hint and the two-finger hint", () => {
		assert.match(html, /Ctrl\+scroll to zoom|Zoom in to pan/);
		assert.match(html, /Two fingers to pan and pinch/);
	});
});
