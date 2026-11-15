/**
 * Unsent ink lives in IndexedDB (owner plan, 2026-11-15): localStorage is 5 MiB for the whole origin. Small pages are also
 * mirrored to localStorage at once (they survive a kill before an IndexedDB write can finish); pages are read back
 * asynchronously, and nothing may treat "not read yet" as "empty". Node has no IndexedDB, so the in-memory store stands in.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const ls = new Map<string, string>();
let lsQuota = Infinity;
const lsTotal = () => [...ls].reduce((n, [k, v]) => n + k.length + v.length, 0);
(globalThis as unknown as { localStorage: Storage }).localStorage = {
	getItem: (k: string) => ls.get(k) ?? null,
	setItem: (k: string, v: string) => {
		if (lsTotal() - (ls.has(k) ? k.length + ls.get(k)!.length : 0) + k.length + v.length > lsQuota) throw new DOMException("full", "QuotaExceededError");
		ls.set(k, v);
	},
	removeItem: (k: string) => void ls.delete(k),
	clear: () => ls.clear(),
	key: (i: number) => [...ls.keys()][i] ?? null,
	get length() {
		return ls.size;
	},
} as Storage;

const mem = await import("../components/sketch/ink-memory.ts");
const { memoryInkStore } = await import("../components/sketch/ink-store.ts");
const { configureInkDrafts } = await import("../components/sketch/ink-drafts.ts");
import type { SketchStroke } from "../src/core";
import type { InkState } from "../components/sketch/ink-memory.ts";

const {
	writeInk, flushInk, forgetInkMemory, readInk, readKept, hydrateInk, isInkReady, afterHydrate, settleInkWrites, setInkStore,
	inkSaveFailed, carryOverInk, restoreDraft, sendPage, pagePayload, MIRROR_MAX_CHARS,
} = mem;

const stroke = (n: number, points = 2): SketchStroke => ({
	size: 4,
	points: Array.from({ length: points }, (_, i) => [n + i * 1.11, n + i * 2.22, 0.5]).flat(),
});
const small = (count: number): InkState => {
	const strokes = Array.from({ length: count }, (_, i) => stroke(i));
	return { strokes, undo: strokes.map((s) => ({ kind: "add" as const, stroke: s })), redo: [] };
};
/** A page well past the mirror limit. */
const big = (): InkState => {
	const strokes = Array.from({ length: 60 }, (_, i) => stroke(i, 400));
	return { strokes, undo: [], redo: [] };
};

let idb = memoryInkStore();
/** A reload: memory gone, both stores stay; the page is read back. */
const reload = async (key: string) => {
	forgetInkMemory();
	await hydrateInk(key);
	return readInk(key);
};

describe("ink in IndexedDB", () => {
	beforeEach(() => {
		setInkStore(null);
		ls.clear();
		lsQuota = Infinity;
		idb = memoryInkStore();
		setInkStore(idb);
		configureInkDrafts({ fetch: null });
	});

	it("is not read yet until hydrated, and then it is", async () => {
		writeInk("a", small(3));
		flushInk();
		await settleInkWrites();
		forgetInkMemory();
		assert.equal(isInkReady("a"), false);
		assert.equal(readInk("a").strokes.length, 0, "not loaded reads as empty ...");
		await hydrateInk("a");
		assert.equal(isInkReady("a"), true);
		assert.equal(readInk("a").strokes.length, 3, "... until the page has been read");
	});

	it("a stroke drawn before the page was read waits for it and lands on the stored ink", async () => {
		writeInk("b", small(3));
		flushInk();
		await settleInkWrites();
		forgetInkMemory();
		idb.delayMs = 5;
		// what the sketch view does: the edit runs after hydration, reading the stored page first
		afterHydrate("b", () => {
			const state = readInk("b");
			writeInk("b", { ...state, strokes: [...state.strokes, stroke(99)] });
		});
		await hydrateInk("b");
		assert.equal(readInk("b").strokes.length, 4, "the stored three plus the new one");
		flushInk();
		await settleInkWrites();
		assert.equal(JSON.parse(idb.data.get("ink:b")!.text).length, 4);
	});

	it("restores from IndexedDB after a reload, with its undo history", async () => {
		writeInk("c", small(4));
		flushInk();
		await settleInkWrites();
		const back = await reload("c");
		assert.equal(back.strokes.length, 4);
		assert.equal(back.undo.length, 4, "the history rides in IndexedDB");
	});

	it("mirrors a small page to localStorage at once, before any IndexedDB write could finish", () => {
		idb.delayMs = 50;
		writeInk("d", small(2));
		flushInk();
		assert.equal(JSON.parse(ls.get("lh:ink:d")!).length, 2, "synchronously in localStorage");
		assert.ok(Number(ls.get("lh:ink-t:d")) > 0, "with its write stamp");
		assert.equal(idb.data.has("ink:d"), false, "while IndexedDB is still busy");
	});

	it("keeps a big page in IndexedDB only, and a full localStorage does not stop it", async () => {
		lsQuota = 1000; // nothing of this page could ever fit in localStorage
		const page = big();
		writeInk("e", page);
		flushInk();
		await settleInkWrites();
		assert.ok(idb.data.get("ink:e")!.text.length > MIRROR_MAX_CHARS);
		assert.equal(ls.has("lh:ink:e"), false);
		assert.equal(inkSaveFailed("e"), false, "saved: the full localStorage is not the store any more");
		assert.equal((await reload("e")).strokes.length, 60);
	});

	it("a page that outgrows its mirror leaves localStorage once IndexedDB has it", async () => {
		writeInk("f", small(2));
		flushInk();
		await settleInkWrites();
		assert.ok(ls.has("lh:ink:f"));
		writeInk("f", big());
		flushInk();
		await settleInkWrites();
		assert.equal(ls.has("lh:ink:f"), false);
		assert.equal(ls.has("lh:ink-t:f"), false);
		assert.equal((await reload("f")).strokes.length, 60);
	});

	it("a refused IndexedDB write: a mirrored page is safe, a big one is reported", async () => {
		idb.failWrites = true;
		writeInk("g1", small(2));
		writeInk("g2", big());
		flushInk();
		await settleInkWrites();
		assert.equal(inkSaveFailed("g1"), false, "small: still in the localStorage mirror");
		assert.equal(inkSaveFailed("g2"), true, "big: nowhere to go");
		assert.equal(ls.has("lh:ink:g2"), false);
		idb.failWrites = false;
		writeInk("g2", big());
		flushInk();
		await settleInkWrites();
		assert.equal(inkSaveFailed("g2"), false, "and it clears once a write goes through");
	});

	it("the newer of the mirror and IndexedDB wins (an IndexedDB write that was lost to a kill)", async () => {
		writeInk("h", small(2));
		flushInk();
		await settleInkWrites();
		idb.failWrites = true; // the next write reaches only the mirror, as if the WebView died first
		writeInk("h", small(5));
		flushInk();
		await settleInkWrites();
		idb.failWrites = false;
		assert.equal(JSON.parse(idb.data.get("ink:h")!.text).length, 2, "IndexedDB is behind");
		assert.equal((await reload("h")).strokes.length, 5, "the mirror is newer, so it is the page");
	});

	it("moves a page from before IndexedDB into it: small stays as the mirror, big leaves localStorage after the copy", async () => {
		ls.set("lh:ink:legacy-small", JSON.stringify(small(3).strokes));
		ls.set("lh:ink:legacy-big", JSON.stringify(big().strokes));
		assert.equal((await reload("legacy-small")).strokes.length, 3);
		assert.equal((await reload("legacy-big")).strokes.length, 60);
		await settleInkWrites();
		assert.ok(idb.data.has("ink:legacy-small") && idb.data.has("ink:legacy-big"), "both copied into IndexedDB");
		assert.ok(ls.has("lh:ink:legacy-small"), "the small one stays as its mirror");
		assert.equal(ls.has("lh:ink:legacy-big"), false, "the big one is let go of after the copy");
	});

	it("a failed copy leaves the old localStorage page exactly as it was", async () => {
		const text = JSON.stringify(big().strokes);
		ls.set("lh:ink:legacy", text);
		idb.failWrites = true;
		assert.equal((await reload("legacy")).strokes.length, 60, "it still opens, from localStorage");
		await settleInkWrites();
		assert.equal(ls.get("lh:ink:legacy"), text);
	});

	it("moves an old localStorage undo history into IndexedDB and lets go of it", async () => {
		const strokes = small(3).strokes;
		const text = JSON.stringify(strokes);
		ls.set("lh:ink:legacy-h", text);
		ls.set("lh:ink-hist:legacy-h", JSON.stringify({ sig: text.length, undo: strokes.map((s) => ({ kind: "add", stroke: s })), redo: [] }));
		assert.equal((await reload("legacy-h")).undo.length, 3);
		await settleInkWrites();
		assert.ok(idb.data.has("hist:legacy-h"));
		assert.equal(ls.has("lh:ink-hist:legacy-h"), false);
	});

	it("a broken IndexedDB read still opens a page that localStorage has", async () => {
		ls.set("lh:ink:r", JSON.stringify(small(2).strokes));
		idb.failReads = true;
		assert.equal((await reload("r")).strokes.length, 2);
	});

	it("clearing a page removes it from both", async () => {
		writeInk("i", small(2));
		flushInk();
		await settleInkWrites();
		writeInk("i", { strokes: [], undo: [], redo: [] });
		flushInk();
		await settleInkWrites();
		assert.equal(ls.has("lh:ink:i"), false);
		assert.equal(idb.data.has("ink:i"), false);
		assert.equal(idb.data.has("hist:i"), false);
	});

	it("an older write that is slow never lands on top of a newer one", async () => {
		idb.delayMs = 5;
		writeInk("j", small(1));
		flushInk();
		writeInk("j", small(4));
		flushInk();
		await settleInkWrites();
		assert.equal(JSON.parse(idb.data.get("ink:j")!.text).length, 4);
	});

	it("carrying a re-ask's ink waits for both pages to be read", async () => {
		writeInk("old", small(3));
		flushInk();
		await settleInkWrites();
		forgetInkMemory();
		assert.equal(carryOverInk("old", "new"), false, "not decided on unread pages");
		await hydrateInk("old");
		await hydrateInk("new");
		await settleInkWrites();
		assert.equal(readInk("new").strokes.length, 3, "moved once both were read");
		assert.equal(readInk("old").strokes.length, 0);
	});

	it("a stored page is not replaced by the server's draft just because it was not read yet", async () => {
		writeInk("k", small(3));
		flushInk();
		await settleInkWrites();
		forgetInkMemory();
		const asked: string[] = [];
		configureInkDrafts({
			fetch: async (url) => {
				asked.push(url);
				return new Response(JSON.stringify(small(1).strokes), { status: 200 });
			},
		});
		restoreDraft("k");
		await hydrateInk("k");
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual(asked, [], "the page had ink of its own: the server was not asked");
		assert.equal(readInk("k").strokes.length, 3);
	});

	it("a sent page is gone from IndexedDB too", async () => {
		writeInk("l", small(3));
		flushInk();
		await settleInkWrites();
		const unsent = readInk("l").strokes;
		await sendPage("l", pagePayload(readKept("l"), unsent), unsent, async () => true);
		flushInk();
		await settleInkWrites();
		assert.equal(idb.data.has("ink:l"), false);
		assert.equal(ls.has("lh:ink:l"), false);
	});
});
