/**
 * The margin-thread clarification (owner design, 2026-11-01; margin threads 2026-11-02), server side: the prompt it builds,
 * the anchor parser, the route handler's gates and storage, and the thread read. A scripted pi engine (the faux provider)
 * stands in for the chat's conversation model; the handler's engineOverride seam takes it as the third argument. Runs under
 * an isolated LH_DATA_DIR (the chat-store-events discipline: the seam is set before any config-loading import, so the app
 * modules are dynamic imports).
 */
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-clarify-"));
process.env.LH_DATA_DIR = TMP_DATA;
// The key-presence gate reads env-first truth; the engine override skips it, but
// keep the environment like any real setup.
process.env.OPENROUTER_API_KEY ??= "test-key-clarify";

const { clarifyPrompt, handleClarifyRead, handleClarifyRequest, parseAnchor } = await import("../src/server/clarify.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { CLARIFY_ANCHOR_MAX, CLARIFY_QUESTION_MAX, CLARIFY_QUOTE_MAX } = await import("../src/core/contracts/chat.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
import type { PiEngine } from "../src/agent/models.ts";

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
	lead: "Right. Next, which planet is closest to the sun.",
};

/** A scripted engine: one step per call, each step recording the context it got. */
function scripted(steps: Array<(ctx: unknown) => unknown>): { engine: PiEngine; contexts: any[] } {
	const contexts: any[] = [];
	const faux = createFauxCore({});
	faux.setResponses(
		steps.map((step) => (ctx: unknown) => {
			contexts.push(ctx);
			return step(ctx);
		}) as unknown as FauxResponseStep[],
	);
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, contexts };
}

const reply = (text: string) => () => fauxAssistantMessage([fauxText(text)]);

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A chat whose history ends in an unanswered quiz (a question is pending). */
function pendingChat(title: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(chat.id, [
		{ id: "m_user", role: "user", content: "teach me the planets", timestamp: 1 } as never,
		{
			id: "m_asst",
			role: "assistant",
			timestamp: 2,
			stopReason: "toolUse",
			api: "openai-completions",
			provider: "openrouter",
			model: "z-ai/glm-5.3-flash",
			usage: USAGE,
			content: [
				{ type: "text", text: "Let's check the basics." },
				{ type: "toolCall", id: "call-1", name: "quiz", arguments: QUIZ_INPUT },
			],
		} as never,
	]);
	return chat;
}

/** A chat with no pending question: the tutor's last message is plain text. */
function answeredChat(title: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(chat.id, [
		{ id: "m_user", role: "user", content: "teach me the planets", timestamp: 1 } as never,
		{
			id: "m_asst",
			role: "assistant",
			timestamp: 2,
			stopReason: "stop",
			api: "openai-completions",
			provider: "openrouter",
			model: "z-ai/glm-5.3-flash",
			usage: USAGE,
			content: [{ type: "text", text: "The inner planets are the rocky ones." }],
		} as never,
	]);
	return chat;
}

const ANCHOR = { messageId: "m_asst", text: "The inner planets", occurrence: 0 };

/** The text of the last user-role message the engine received (the clarification's one instruction). */
function lastUserText(ctx: { messages: Array<{ role: string; content: unknown }> }): string {
	const last = [...ctx.messages].reverse().find((m) => m.role === "user");
	assert.ok(last, "the engine got a user message");
	return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
}

function post(chatId: string, body: unknown): Promise<Response> {
	return handleClarifyRequest(chatId, body, undefined);
}

describe("clarifyPrompt — the call's one instruction", () => {
	it("pending: carries the never-reveal rule and names the pending question", () => {
		const text = clarifyPrompt({ quote: "the inner planets", question: "what does inner mean?", earlier: [], pending: true });
		assert.ok(text.includes("Do NOT state"), "the never-reveal rule is stated");
		assert.ok(text.includes("pending question"), "it names the pending question");
	});

	it("not pending: no never-reveal rule, says no question is waiting, still plain text with no tool calls", () => {
		const text = clarifyPrompt({ quote: "the inner planets", question: "what does inner mean?", earlier: [], pending: false });
		assert.equal(text.includes("Do NOT state"), false, "the never-reveal rule is absent");
		assert.ok(text.includes("No question is waiting"), "it says no question is waiting");
		assert.ok(text.includes("plain text only (no tool calls)"), "still plain text, no tool calls");
	});

	it("includes the marked text and the question", () => {
		for (const pending of [true, false]) {
			const text = clarifyPrompt({ quote: "the inner planets", question: "what does inner mean?", earlier: [], pending });
			assert.ok(text.includes("the inner planets"), "the marked text");
			assert.ok(text.includes("what does inner mean?"), "the question");
		}
	});

	it("earlier pairs appear in order under the section heading, and the last label reads follow-up", () => {
		const text = clarifyPrompt({
			quote: "third passage",
			question: "third question?",
			earlier: [
				{ question: "first question?", reply: "first reply" },
				{ question: "second question?", reply: "second reply" },
			],
			pending: false,
		});
		const heading = text.indexOf("The conversation about this passage so far:");
		assert.ok(heading >= 0, "the earlier section heading is present");
		const order = ["first question?", "first reply", "second question?", "second reply", "third question?"].map((s) => text.indexOf(s));
		for (const i of order) assert.ok(i > heading, "after the heading");
		assert.deepEqual(order, [...order].sort((a, b) => a - b), "in order");
		assert.ok(text.includes("Learner's follow-up: third question?"), "the last label is follow-up");
	});

	it("no earlier pairs: no such section, and the label reads question", () => {
		const text = clarifyPrompt({ quote: "q", question: "question?", earlier: [], pending: true });
		assert.equal(text.includes("The conversation about this passage so far"), false);
		assert.ok(text.includes("Learner's question: question?"), "the label is question");
		assert.equal(text.includes("follow-up"), false);
	});
});

describe("parseAnchor — the anchor of a new thread", () => {
	it("accepts a valid anchor and returns it", () => {
		assert.deepEqual(parseAnchor({ messageId: "m1", text: "The inner planets", occurrence: 2 }), {
			messageId: "m1",
			text: "The inner planets",
			occurrence: 2,
		});
	});

	it("rejects an empty messageId", () => {
		assert.equal(parseAnchor({ messageId: "", text: "x", occurrence: 0 }), null);
		assert.equal(parseAnchor({ text: "x", occurrence: 0 }), null);
	});

	it("rejects empty or whitespace-only text", () => {
		assert.equal(parseAnchor({ messageId: "m1", text: "", occurrence: 0 }), null);
		assert.equal(parseAnchor({ messageId: "m1", text: "   ", occurrence: 0 }), null);
	});

	it("rejects text over CLARIFY_ANCHOR_MAX and accepts exactly that length", () => {
		assert.equal(parseAnchor({ messageId: "m1", text: "a".repeat(CLARIFY_ANCHOR_MAX + 1), occurrence: 0 }), null);
		assert.ok(parseAnchor({ messageId: "m1", text: "a".repeat(CLARIFY_ANCHOR_MAX), occurrence: 0 }));
	});

	it("rejects a non-integer or negative occurrence", () => {
		assert.equal(parseAnchor({ messageId: "m1", text: "x", occurrence: 1.5 }), null);
		assert.equal(parseAnchor({ messageId: "m1", text: "x", occurrence: -1 }), null);
		assert.equal(parseAnchor({ messageId: "m1", text: "x", occurrence: "0" }), null);
		assert.equal(parseAnchor({ messageId: "m1", text: "x" }), null);
	});
});

describe("handleClarifyRequest — the gates", () => {
	it("400 for an empty question and an over-long question", async () => {
		const chat = pendingChat("Clarify gates question");
		assert.equal((await post(chat.id, { question: "  ", anchor: ANCHOR, quote: "x" })).status, 400, "empty question");
		const long = await post(chat.id, { question: "q".repeat(CLARIFY_QUESTION_MAX + 1), anchor: ANCHOR, quote: "x" });
		assert.equal(long.status, 400, "over-long question");
	});

	it("400 for a new thread with a missing anchor", async () => {
		const chat = pendingChat("Clarify gates anchor");
		assert.equal((await post(chat.id, { question: "y", quote: "x" })).status, 400);
	});

	it("400 for an empty quote and an over-long quote", async () => {
		const chat = pendingChat("Clarify gates quote");
		assert.equal((await post(chat.id, { question: "y", anchor: ANCHOR, quote: "   " })).status, 400, "empty quote");
		assert.equal((await post(chat.id, { question: "y", anchor: ANCHOR, quote: "a".repeat(CLARIFY_QUOTE_MAX + 1) })).status, 400, "over-long quote");
	});

	it("404 for an unknown chat", async () => {
		const res = await post("chat_never_existed", { question: "y", anchor: ANCHOR, quote: "x" });
		assert.equal(res.status, 404);
	});

	it("400 'no longer in the session' when the anchor's messageId is not in the record", async () => {
		const chat = pendingChat("Clarify gates gone");
		const res = await post(chat.id, { question: "y", anchor: { ...ANCHOR, messageId: "m_gone" }, quote: "x" });
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { error: string }).error, /no longer in the session/);
	});

	it("404 for an unknown threadId", async () => {
		const chat = pendingChat("Clarify gates thread");
		const res = await post(chat.id, { threadId: "thread_never_existed", question: "y" });
		assert.equal(res.status, 404);
	});

	it("409 while a turn is running on the chat", async () => {
		const chat = pendingChat("Clarify gates turn");
		assert.equal(beginTurn(chat.id), true);
		try {
			const res = await post(chat.id, { question: "y", anchor: ANCHOR, quote: "x" });
			assert.equal(res.status, 409);
		} finally {
			endTurn(chat.id);
		}
	});
});

describe("handleClarifyRequest — the answer", () => {
	it("a new thread with NO pending question: 200 {thread}, one entry, stored; messages untouched", async () => {
		const chat = answeredChat("Clarify no pending");
		const before = chatStore.getChat(chat.id)!;
		const messagesBefore = JSON.stringify(before.messages);
		const { engine, contexts } = scripted([reply("They are Mercury, Venus, Earth and Mars.")]);

		const res = await handleClarifyRequest(chat.id, { anchor: ANCHOR, quote: "  The inner planets  ", question: "which ones?" }, engine);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { thread: { id: string; anchor: unknown; quote: string; entries: Array<{ question: string; reply: string }> } };
		assert.equal(body.thread.entries.length, 1);
		assert.equal(body.thread.entries[0]!.question, "which ones?");
		assert.equal(body.thread.entries[0]!.reply, "They are Mercury, Venus, Earth and Mars.");
		assert.equal(body.thread.quote, "The inner planets", "the quote is trimmed");

		const after = chatStore.getChat(chat.id)!;
		const stored = after.clarifyThreads?.find((t) => t.id === body.thread.id);
		assert.ok(stored, "the thread is stored on the record");
		assert.equal(stored.entries.length, 1);
		assert.deepEqual(stored.anchor, ANCHOR);
		assert.equal(after.messages.length, before.messages.length, "messages length unchanged");
		assert.deepEqual(after.messages.map((m) => m.id), before.messages.map((m) => m.id), "message ids unchanged");
		assert.equal(JSON.stringify(after.messages), messagesBefore, "messages unchanged");

		assert.ok(contexts[0], "the engine was called once");
		const prompt = lastUserText(contexts[0]);
		assert.ok(prompt.includes("No question is waiting"), "no pending question: the free-answer instruction");
		assert.equal(prompt.includes("Do NOT state"), false, "no never-reveal rule without a pending question");
	});

	it("a new thread WITH a pending quiz question: the prompt the engine got carries the never-reveal rule", async () => {
		const chat = pendingChat("Clarify pending");
		const { engine, contexts } = scripted([reply("Inner means nearest the sun.")]);
		const res = await handleClarifyRequest(chat.id, { anchor: ANCHOR, quote: "the inner planets", question: "what does inner mean?" }, engine);
		assert.equal(res.status, 200);
		assert.ok(contexts[0], "the engine was called");
		assert.ok(lastUserText(contexts[0]).includes("Do NOT state"), "the never-reveal rule reached the engine");
	});

	it("a follow-up with {threadId, question}: same thread, two entries, and the prompt carries the first pair", async () => {
		const chat = answeredChat("Clarify follow-up");
		const { engine, contexts } = scripted([reply("First answer."), reply("Second answer.")]);
		const first = (await (await handleClarifyRequest(chat.id, { anchor: ANCHOR, quote: "the inner planets", question: "first question?" }, engine)).json()) as {
			thread: { id: string };
		};

		const res = await handleClarifyRequest(chat.id, { threadId: first.thread.id, question: "second question?" }, engine);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { thread: { id: string; entries: Array<{ question: string; reply: string }> } };
		assert.equal(body.thread.id, first.thread.id, "the same thread");
		assert.deepEqual(body.thread.entries.map((e) => e.question), ["first question?", "second question?"]);

		const stored = chatStore.getChat(chat.id)!.clarifyThreads ?? [];
		assert.equal(stored.length, 1, "still one thread on the record");
		assert.equal(stored[0]!.entries.length, 2);

		const prompt = lastUserText(contexts[1]);
		assert.ok(prompt.includes("first question?"), "the earlier question is in the prompt");
		assert.ok(prompt.includes("First answer."), "the earlier reply is in the prompt");
		assert.ok(prompt.includes("follow-up"), "the label reads follow-up");
	});

	it("an engine that throws → 502 and nothing stored", async () => {
		const chat = answeredChat("Clarify throws");
		const { engine } = scripted([() => { throw new Error("upstream down"); }]);
		const res = await handleClarifyRequest(chat.id, { anchor: ANCHOR, quote: "x", question: "y" }, engine);
		assert.equal(res.status, 502);
		assert.equal((chatStore.getChat(chat.id)!.clarifyThreads ?? []).length, 0);
	});

	it("an empty reply → 502 and nothing stored", async () => {
		const chat = answeredChat("Clarify empty");
		const { engine } = scripted([reply("   ")]);
		const res = await handleClarifyRequest(chat.id, { anchor: ANCHOR, quote: "x", question: "y" }, engine);
		assert.equal(res.status, 502);
		assert.equal((chatStore.getChat(chat.id)!.clarifyThreads ?? []).length, 0);
	});
});

describe("handleClarifyRead", () => {
	it("returns [] for a chat without threads, and the stored threads otherwise", async () => {
		const chat = answeredChat("Clarify read");
		const none = (await handleClarifyRead(chat.id).json()) as { threads: unknown[] };
		assert.deepEqual(none.threads, []);

		const { engine } = scripted([reply("Read me back.")]);
		await handleClarifyRequest(chat.id, { anchor: ANCHOR, quote: "p", question: "q?" }, engine);

		const res = handleClarifyRead(chat.id);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { threads: Array<{ quote: string; anchor: unknown; entries: Array<{ question: string; reply: string }> }> };
		assert.equal(body.threads.length, 1);
		assert.equal(body.threads[0]!.quote, "p");
		assert.deepEqual(body.threads[0]!.anchor, ANCHOR);
		assert.equal(body.threads[0]!.entries[0]!.question, "q?");
		assert.equal(body.threads[0]!.entries[0]!.reply, "Read me back.");
	});

	it("404 for an unknown chat", () => {
		assert.equal(handleClarifyRead("chat_never_existed").status, 404);
	});
});
