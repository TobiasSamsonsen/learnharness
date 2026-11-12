/**
 * Upstream's side questions, Cite toolbar and companion are switched off in the fork (owner, 2026-11-12:
 * components/fork-switches.ts). The production Chat is mounted with a saved side thread that the server reports as
 * open: off, nothing of the feature is on the page; on (the holder flipped for one case), its "?" button is back, which
 * shows the off case is not passing for want of an entry point.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { Chat } from "../components/chat.tsx";
import { isHiddenKeyAction, upstreamSelectionTools } from "../components/fork-switches.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const messages: LhMessage[] = [
	{ id: "u1", role: "user", content: "Teach me.", timestamp: 1 } as LhMessage,
	{ id: "a1", role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: 2, stopReason: "stop", usage,
		content: [{ type: "text", text: "A synthetic teaching segment about limits." }] } as LhMessage,
];
const thread = {
	id: "side_a1", open: true, createdAt: "2026-11-12T00:00:00.000Z",
	anchor: { messageId: "a1", partId: "a1-t0", blockIndex: 0, blockText: "A synthetic teaching segment about limits." },
	messages: [
		{ id: "q1", role: "user", text: "Why?", at: "2026-11-12T00:00:01.000Z" },
		{ id: "r1", role: "assistant", text: "Because.", at: "2026-11-12T00:00:02.000Z" },
	],
};

async function mountChat() {
	const savedObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
	Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
	const fixture = await mountPluginChrome({ activate() {} }, <Chat chatId="one" title="Synthetic lesson" initialMessages={messages} />, {
		pathname: "/chat/one",
		prepareDom(dom) {
			const prototype = dom.window.HTMLElement.prototype;
			const saved = [
				[dom.window, "location"], [dom.window, "localStorage"], [prototype, "getAnimations"], [prototype, "offsetWidth"], [dom.window.document, "getSelection"],
			].map(([object, key]) => ({ object: object as object, key: key as string, descriptor: Object.getOwnPropertyDescriptor(object, key as string) }));
			const values = new Map<string, string>();
			Object.defineProperty(dom.window, "location", { configurable: true, value: new URL("http://fixture/chat/one") });
			Object.defineProperty(dom.window, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
			Object.defineProperty(dom.window.document, "getSelection", { configurable: true, value: () => null });
			Object.defineProperty(prototype, "getAnimations", { configurable: true, value: () => [] });
			Object.defineProperty(prototype, "offsetWidth", { configurable: true, get() { return this.clientWidth; } });
			return () => { for (const { object, key, descriptor } of saved) { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); } };
		},
		fetch: async input => {
			const url = String(input);
			if (url === "/api/models") return Response.json({ providers: [], models: [], slots: {} });
			if (url === "/api/settings") return Response.json({});
			if (url === "/api/chats/one") return Response.json({ id: "one", messages, sideChats: [thread] });
			if (url === "/api/chats/one/side-chats") return Response.json({ threads: [thread] });
			if (url === "/api/jobs?chatId=one") return Response.json({ jobs: [], turnInFlight: false });
			assert.fail(`Unexpected fixture request: ${url}`);
		},
	});
	return {
		document: fixture.document,
		async close() {
			await fixture.close();
			if (savedObserver) Object.defineProperty(globalThis, "ResizeObserver", savedObserver); else Reflect.deleteProperty(globalThis, "ResizeObserver");
		},
	};
}

const SIDE_UI = '[data-testid="side-conversation-button"], [data-testid="side-thread"], [data-testid="side-thread-popover"], aside[aria-label="Side question"]';

test("the switch is off by default, and Mod+J is not offered while it is", () => {
	assert.equal(upstreamSelectionTools.current, false);
	assert.equal(isHiddenKeyAction("toggle-question-thread"), true);
	assert.equal(isHiddenKeyAction("find"), false);
});

test("off: Chat shows no side-question button and no companion, even for a saved open side thread", async () => {
	const chat = await mountChat();
	try {
		assert.ok(chat.document.body.textContent?.includes("A synthetic teaching segment about limits."), "the lesson itself rendered");
		assert.equal(chat.document.querySelectorAll(SIDE_UI).length, 0);
	} finally { await chat.close(); }
});

test("on: the same Chat offers the side-question button again (the off case is a real difference)", async () => {
	upstreamSelectionTools.current = true;
	try {
		assert.equal(isHiddenKeyAction("toggle-question-thread"), false);
		const chat = await mountChat();
		try {
			assert.ok(chat.document.querySelector('[data-testid="side-conversation-button"]'));
		} finally { await chat.close(); }
	} finally { upstreamSelectionTools.current = false; }
});
