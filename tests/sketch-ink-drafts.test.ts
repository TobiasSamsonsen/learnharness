/**
 * The server copy of unsent ink (owner plan, 2026-11-15): pushed after a pause, restored on a page with no ink of its own, removed
 * when the page is sent or cleared, and never in the way of the local copy.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
	key: (i: number) => [...store.keys()][i] ?? null,
	get length() {
		return store.size;
	},
} as Storage;

const server = new Map<string, string>();
const calls: string[] = [];
let down = false;
const fakeFetch = async (input: string, init?: RequestInit): Promise<Response> => {
	const key = decodeURIComponent(input.split("/").pop()!);
	const method = init?.method ?? "GET";
	calls.push(`${method} ${key}`);
	if (down) throw new TypeError("server unreachable");
	if (method === "PUT") {
		server.set(key, String(init!.body));
		return new Response(null, { status: 204 });
	}
	if (method === "DELETE") {
		server.delete(key);
		return new Response(null, { status: 204 });
	}
	return server.has(key) ? new Response(server.get(key)) : new Response("{}", { status: 404 });
};

const { writeInk, readInk, flushInk, forgetInkMemory, restoreDraft, inkFromStrokes } = await import("../components/sketch/ink-memory.ts");
const { configureInkDrafts } = await import("../components/sketch/ink-drafts.ts");

const stroke = (n: number) => ({ size: 4, points: [n, n, 0.5, n + 10, n + 10, 0.5] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the server copy of unsent ink", () => {
	beforeEach(() => {
		flushInk();
		store.clear();
		server.clear();
		calls.length = 0;
		down = false;
		configureInkDrafts({ fetch: fakeFetch, delayMs: 20 });
		forgetInkMemory();
	});

	it("is written after a pause in drawing, once, with the newest page", async () => {
		writeInk("d1", inkFromStrokes([stroke(1)]));
		flushInk();
		writeInk("d1", inkFromStrokes([stroke(1), stroke(2)]));
		flushInk();
		await sleep(80);
		assert.equal(JSON.parse(server.get("d1")!).length, 2);
		assert.equal(calls.filter((c) => c.startsWith("PUT")).length, 1, "one push, not one per change");
	});

	it("comes back on a page with no ink of its own, even when the browser's copy is gone", async () => {
		writeInk("d2", inkFromStrokes([stroke(1), stroke(2), stroke(3)]));
		flushInk();
		await sleep(80);
		forgetInkMemory();
		store.clear(); // the browser store is gone (full, cleared, a new WebView)
		assert.equal(readInk("d2").strokes.length, 0);
		restoreDraft("d2");
		await sleep(40);
		assert.equal(readInk("d2").strokes.length, 3);
	});

	it("never overwrites ink the page already has", async () => {
		server.set("d3", JSON.stringify([stroke(7)]));
		writeInk("d3", inkFromStrokes([stroke(1), stroke(2)]));
		restoreDraft("d3");
		await sleep(40);
		assert.equal(readInk("d3").strokes.length, 2);
	});

	it("is removed when the page is cleared or sent, and a push still waiting is cancelled", async () => {
		writeInk("d4", inkFromStrokes([stroke(1)]));
		flushInk();
		await sleep(80);
		assert.ok(server.has("d4"));
		writeInk("d4", { strokes: [], undo: [], redo: [] });
		flushInk();
		await sleep(40);
		assert.equal(server.has("d4"), false);
		writeInk("d5", inkFromStrokes([stroke(1)]));
		writeInk("d5", { strokes: [], undo: [], redo: [] });
		flushInk();
		await sleep(80);
		assert.equal(server.has("d5"), false, "the cancelled push never reached the server");
	});

	it("a dead server changes nothing locally and breaks nothing", async () => {
		down = true;
		writeInk("d6", inkFromStrokes([stroke(1), stroke(2)]));
		flushInk();
		await sleep(80);
		assert.equal(JSON.parse(store.get("lh:ink:d6")!).length, 2);
		assert.equal(readInk("d6").strokes.length, 2);
	});

	it("a damaged draft restores nothing", async () => {
		server.set("d7", "{not json");
		restoreDraft("d7");
		await sleep(40);
		assert.equal(readInk("d7").strokes.length, 0);
	});
});
