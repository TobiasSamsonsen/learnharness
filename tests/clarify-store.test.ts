/**
 * The clarification side thread in the chat store (owner design, 2026-11-01):
 * appended per pending question, idempotent per clarification id, silent
 * (updatedAt unchanged), never touching `messages`, and absent from the sidebar
 * list summaries. Runs under an isolated LH_DATA_DIR (the chat-store-events
 * discipline: the seam is set before any config-loading import).
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

function entry(id: string, question: string) {
	return { id, quote: "a passage", question, reply: `reply to ${question}`, at: "2026-11-01T00:00:00.000Z" };
}

describe("appendClarification — the side thread", () => {
	it("appends in order under the question's key", () => {
		const chat = chatStore.createChat("Clarify store order");
		chatStore.appendClarification(chat.id, "call-1", entry("c1", "first?"));
		chatStore.appendClarification(chat.id, "call-1", entry("c2", "second?"));
		const record = chatStore.getChat(chat.id)!;
		assert.deepEqual(
			record.clarifications?.["call-1"]?.map((c) => c.id),
			["c1", "c2"],
		);
	});

	it("is idempotent per clarification id", () => {
		const chat = chatStore.createChat("Clarify store idempotent");
		chatStore.appendClarification(chat.id, "call-1", entry("c1", "once?"));
		chatStore.appendClarification(chat.id, "call-1", entry("c1", "once?"));
		assert.equal(chatStore.getChat(chat.id)!.clarifications?.["call-1"]?.length, 1);
	});

	it("keeps updatedAt unchanged and does not change messages", () => {
		const chat = chatStore.createChat("Clarify store silent");
		chatStore.saveMessages(chat.id, [
			{ id: "m1", role: "user", content: "hello", timestamp: 1 } as never,
		]);
		const before = chatStore.getChat(chat.id)!;
		const updatedAt = before.updatedAt;
		const messagesBefore = JSON.stringify(before.messages);

		chatStore.appendClarification(chat.id, "call-1", entry("c1", "silent?"));

		const after = chatStore.getChat(chat.id)!;
		assert.equal(after.updatedAt, updatedAt, "updatedAt is preserved");
		assert.equal(JSON.stringify(after.messages), messagesBefore, "messages are untouched");
		assert.equal(after.messages.length, before.messages.length);
	});

	it("throws for an unknown chat", () => {
		assert.throws(() => chatStore.appendClarification("chat_never_existed", "call-1", entry("c1", "?")), /Chat not found/);
	});
});

describe("list summaries leave clarifications out", () => {
	it("the sidebar list has no clarifications key, while the record keeps it", () => {
		const chat = chatStore.createChat("Clarify store summary");
		chatStore.appendClarification(chat.id, "call-1", entry("c1", "in the list?"));
		const summary = chatStore.listChats().find((s) => s.id === chat.id);
		assert.ok(summary, "the chat is listed");
		assert.equal("clarifications" in summary, false);
		assert.equal(chatStore.getChat(chat.id)!.clarifications?.["call-1"]?.length, 1);
	});
});
