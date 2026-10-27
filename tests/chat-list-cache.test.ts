/**
 * M11: listChats keeps a summary per chat file, keyed on mtime + size (docs/android/m11-plan.md Q4).
 * A hit is proven by a SAME-size edit that keeps the old mtime still reading as the old title: the
 * file really changed, the list did not look. Runs under an isolated LH_DATA_DIR (the seam is set
 * before any config-loading import, so the store import is dynamic).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-list-cache-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { PATHS } = await import("../config.ts");

test.after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const file = (id: string) => path.join(PATHS.chats, `${id}.json`);
const titleOf = (id: string) => chatStore.listChats().find((c) => c.id === id)?.title;

test("a repeat list reuses the summary: a same-size edit that keeps the mtime is not seen", () => {
	const chat = chatStore.createChat("Alpha one");
	// a whole-second mtime restores exactly (a float round trip loses ~100 ns of a real one)
	const SECOND = 1_700_000_000;
	fs.utimesSync(file(chat.id), SECOND, SECOND);
	assert.equal(titleOf(chat.id), "Alpha one");
	const size = fs.statSync(file(chat.id)).size;
	fs.writeFileSync(file(chat.id), fs.readFileSync(file(chat.id), "utf-8").replace("Alpha one", "Alpha two"));
	fs.utimesSync(file(chat.id), SECOND, SECOND); // the foreign edit leaves no trace in the stat
	assert.equal(fs.statSync(file(chat.id)).size, size);
	assert.equal(titleOf(chat.id), "Alpha one", "served from the cache");
});

test("a changed mtime (or size) is re-read", () => {
	const chat = chatStore.createChat("Bravo one");
	assert.equal(titleOf(chat.id), "Bravo one");
	fs.writeFileSync(file(chat.id), fs.readFileSync(file(chat.id), "utf-8").replace("Bravo one", "Bravo two"));
	const later = new Date(Date.now() + 5_000);
	fs.utimesSync(file(chat.id), later, later);
	assert.equal(titleOf(chat.id), "Bravo two");
	// a size change alone, mtime restored
	const mtime = fs.statSync(file(chat.id)).mtime;
	fs.writeFileSync(file(chat.id), fs.readFileSync(file(chat.id), "utf-8").replace("Bravo two", "Bravo three"));
	fs.utimesSync(file(chat.id), mtime, mtime);
	assert.equal(titleOf(chat.id), "Bravo three");
});

test("our own writes and deletes are seen at once, whatever the stat says", () => {
	const chat = chatStore.createChat("Charlie");
	assert.equal(titleOf(chat.id), "Charlie");
	chatStore.renameChat(chat.id, "Delta"); // same-size title would hide behind an unchanged stat; the write drops the entry
	assert.equal(titleOf(chat.id), "Delta");
	chatStore.renameChat(chat.id, "Eeeee");
	assert.equal(titleOf(chat.id), "Eeeee", "a second same-length rename in the same tick");
	assert.equal(chatStore.deleteChat(chat.id), true);
	assert.equal(titleOf(chat.id), undefined, "a deleted chat leaves the list");
});

test("callers can decorate the list without touching the cache", () => {
	const chat = chatStore.createChat("Foxtrot");
	const first = chatStore.listChats().find((c) => c.id === chat.id)!;
	(first as { title: string }).title = "mutated";
	assert.equal(titleOf(chat.id), "Foxtrot");
});

test("a corrupt file is skipped, and listed again once repaired", () => {
	const chat = chatStore.createChat("Golf");
	assert.equal(titleOf(chat.id), "Golf");
	const good = fs.readFileSync(file(chat.id), "utf-8");
	fs.writeFileSync(file(chat.id), "{ not json");
	assert.equal(titleOf(chat.id), undefined);
	fs.writeFileSync(file(chat.id), good);
	const later = new Date(Date.now() + 10_000);
	fs.utimesSync(file(chat.id), later, later);
	assert.equal(titleOf(chat.id), "Golf");
});
