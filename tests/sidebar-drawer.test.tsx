/**
 * The sidebar drawer (M5): below 1024px a plain browser/WebView gets a modal
 * overlay drawer whose open state is its own — closed by default, toggled and
 * closed without ever touching the stored inline preference — while a wide
 * screen keeps the inline sidebar and its stored preference.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DRAWER_QUERY, SidebarProvider, useSidebar } from "../components/sidebar.tsx";

const dom = parseHTML("<html><body></body></html>");
const writes: [string, string][] = [];
let stored: string | null = null;
let narrow = false;
let listeners: (() => void)[] = [];
const matchMedia = (query: string) => ({
	get matches() {
		return query === DRAWER_QUERY && narrow;
	},
	addEventListener: (_: string, cb: () => void) => listeners.push(cb),
	removeEventListener: (_: string, cb: () => void) => {
		listeners = listeners.filter((l) => l !== cb);
	},
});
Object.assign(globalThis, {
	window: Object.assign(dom.window, { matchMedia }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: {
		getItem: () => stored,
		setItem: (k: string, v: string) => writes.push([k, v]),
	},
});

let ctx: ReturnType<typeof useSidebar>;
function Probe() {
	ctx = useSidebar();
	return null;
}
let root: Root | undefined, host: HTMLDivElement | undefined;
async function mount() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<SidebarProvider><Probe /></SidebarProvider>));
}
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = host = undefined;
	writes.length = 0;
	stored = null;
	narrow = false;
	listeners = [];
});

test("the breakpoint is Tailwind's lg line, shared with the settings dialog", () => {
	assert.equal(DRAWER_QUERY, "(width < 64rem)");
});

test("wide: the inline sidebar keeps its stored preference (default open) and persists a toggle", async () => {
	await mount();
	assert.equal(ctx.overlay, false);
	assert.equal(ctx.open, true, "first run opens the sidebar");
	await act(async () => ctx.toggle());
	assert.equal(ctx.open, false);
	assert.deepEqual(writes, [["lh:sidebar-open", "0"]]);
});

test("narrow: the drawer starts closed whatever the stored preference says, and never writes it", async () => {
	stored = "1"; // "open on a wide screen"
	narrow = true;
	await mount();
	assert.equal(ctx.overlay, true);
	assert.equal(ctx.open, false, "a tablet never paints the inline-open sidebar");
	await act(async () => ctx.toggle());
	assert.equal(ctx.open, true);
	await act(async () => ctx.toggle());
	assert.equal(ctx.open, false);
	await act(async () => ctx.toggle());
	await act(async () => ctx.close());
	assert.equal(ctx.open, false, "close shuts the drawer (picking a destination calls it)");
	assert.deepEqual(writes, [], "the drawer never touches lh:sidebar-open");
});

test("crossing the breakpoint switches modes live: back to wide restores the stored preference", async () => {
	stored = "1";
	narrow = true;
	await mount();
	await act(async () => ctx.toggle());
	assert.equal(ctx.open, true);
	narrow = false;
	await act(async () => listeners.forEach((l) => l()));
	assert.equal(ctx.overlay, false);
	assert.equal(ctx.open, true, "the stored preference was open");
	narrow = true;
	await act(async () => listeners.forEach((l) => l()));
	assert.equal(ctx.overlay, true);
	assert.equal(ctx.open, true, "the drawer's own state survived the round trip");
});

test("close is a no-op inline", async () => {
	await mount();
	await act(async () => ctx.close());
	assert.equal(ctx.open, true);
});
