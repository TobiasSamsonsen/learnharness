/**
 * The margin threads in the chat store (owner design, 2026-11-02): `appendClarifyEntry` creates a thread on its first
 * entry and extends it after, idempotent per entry id; the threads never touch `messages` or `updatedAt`; the sidebar
 * list leaves them out; the legacy `clarifications` field round-trips untouched. Runs under an isolated LH_DATA_DIR (the
 * chat-store-events discipline: the seam is set before any config-loading import).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-clarify-store-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const ANCHOR = { messageId: "m1", text: "a passage", occurrence: 0 };

function entry(id: string, question: string, at = "2026-11-01T00:00:00.000Z") {
	return { id, question, reply: `reply to ${question}`, at };
}

function thread(id: string) {
	return { id, anchor: ANCHOR, quote: "a passage in full" };
}

function seededChat(title: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveMessages(chat.id, [{ id: "m1", role: "user", content: "hello", timestamp: 1 } as never]);
	return chat;
}

describe("appendClarifyEntry — creating and extending a thread", () => {
	it("the first entry creates the thread with its anchor, quote and startedAt = entry.at", () => {
		const chat = seededChat("Thread create");
		chatStore.appendClarifyEntry(chat.id, thread("t1"), entry("e1", "first?", "2026-11-02T10:00:00.000Z"));
		const threads = chatStore.getChat(chat.id)!.clarifyThreads!;
		assert.equal(threads.length, 1);
		assert.equal(threads[0]!.id, "t1");
		assert.deepEqual(threads[0]!.anchor, ANCHOR);
		assert.equal(threads[0]!.quote, "a passage in full");
		assert.equal(threads[0]!.startedAt, "2026-11-02T10:00:00.000Z");
		assert.deepEqual(threads[0]!.entries, [entry("e1", "first?", "2026-11-02T10:00:00.000Z")]);
	});

	it("follow-up entries append in order to the same thread", () => {
		const chat = seededChat("Thread follow-up");
		chatStore.appendClarifyEntry(chat.id, thread("t1"), entry("e1", "first?"));
		chatStore.appendClarifyEntry(chat.id, thread("t1"), entry("e2", "second?"));
		chatStore.appendClarifyEntry(chat.id, thread("t1"), entry("e3", "third?"));
		const threads = chatStore.getChat(chat.id)!.clarifyThreads!;
		assert.equal(threads.length, 1, "still one thread");
		assert.deepEqual(threads[0]!.entries.map((e) => e.id), ["e1", "e2", "e3"]);
		assert.equal(threads[0]!.startedAt, "2026-11-01T00:00:00.000Z", "startedAt stays the first entry's time");
	});

	it("is idempotent per entry id", () => {
		const chat = seededChat("Thread idempotent");
		chatStore.appendClarifyEntry(chat.id, thread("t1"), entry("e1", "once?"));
		chatStore.appendClarifyEntry(chat.id, thread("t1"), entry("e1", "once?"));
		assert.equal(chatStore.getChat(chat.id)!.clarifyThreads![0]!.entries.length, 1);
	});

	it("two threads stay separate", () => {
		const chat = seededChat("Thread separate");
		chatStore.appendClarifyEntry(chat.id, thread("t1"), entry("e1", "on the first thread?"));
		chatStore.appendClarifyEntry(chat.id, { id: "t2", anchor: { ...ANCHOR, occurrence: 1 }, quote: "another" }, entry("e2", "on the second thread?"));
		chatStore.appendClarifyEntry(chat.id, thread("t1"), entry("e3", "back on the first?"));
		const threads = chatStore.getChat(chat.id)!.clarifyThreads!;
		assert.deepEqual(threads.map((t) => t.id), ["t1", "t2"]);
		assert.deepEqual(threads[0]!.entries.map((e) => e.id), ["e1", "e3"]);
		assert.deepEqual(threads[1]!.entries.map((e) => e.id), ["e2"]);
		assert.equal(threads[1]!.anchor.occurrence, 1, "the second thread keeps its own anchor");
		assert.equal(threads[1]!.quote, "another");
	});

	it("keeps updatedAt and messages unchanged", () => {
		const chat = seededChat("Thread silent");
		const before = chatStore.getChat(chat.id)!;
		const messagesBefore = JSON.stringify(before.messages);

		chatStore.appendClarifyEntry(chat.id, thread("t1"), entry("e1", "silent?"));

		const after = chatStore.getChat(chat.id)!;
		assert.equal(after.updatedAt, before.updatedAt, "updatedAt is preserved");
		assert.equal(JSON.stringify(after.messages), messagesBefore, "messages are untouched");
		assert.equal(after.messages.length, before.messages.length);
	});

	it("throws for an unknown chat", () => {
		assert.throws(() => chatStore.appendClarifyEntry("chat_never_existed", thread("t1"), entry("e1", "?")), /Chat not found/);
	});
});

describe("list summaries leave the threads out", () => {
	it("the sidebar list has neither clarifyThreads nor clarifications, while the record keeps the thread", () => {
		const chat = seededChat("Thread summary");
		chatStore.appendClarifyEntry(chat.id, thread("t1"), entry("e1", "in the list?"));
		const summary = chatStore.listChats().find((s) => s.id === chat.id);
		assert.ok(summary, "the chat is listed");
		assert.equal("clarifyThreads" in summary, false);
		assert.equal("clarifications" in summary, false);
		assert.equal(chatStore.getChat(chat.id)!.clarifyThreads![0]!.entries.length, 1);
	});
});

describe("the legacy clarifications field", () => {
	it("a record with only the legacy field round-trips untouched through an append", () => {
		const chat = seededChat("Thread legacy");
		// Write the legacy shape straight into the record file, as the 2026-11-01 panel left it.
		const file = path.join(TMP_DATA, "chats", `${chat.id}.json`);
		const legacy = {
			"call-1": [{ id: "old1", quote: "old passage", question: "old question?", reply: "old reply", at: "2026-11-01T00:00:00.000Z" }],
		};
		const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
		fs.writeFileSync(file, JSON.stringify({ ...onDisk, clarifications: legacy }, null, "\t"));
		const messagesBefore = JSON.stringify(chatStore.getChat(chat.id)!.messages);

		chatStore.appendClarifyEntry(chat.id, thread("t1"), entry("e1", "new thread?"));

		const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
		assert.deepEqual(stored.clarifications, legacy, "the legacy field is untouched");
		assert.equal(JSON.stringify(stored.messages), messagesBefore, "messages untouched");
		assert.equal(stored.clarifyThreads.length, 1, "the new thread is stored beside it");
	});
});
