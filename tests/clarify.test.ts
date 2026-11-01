/**
 * The clarification call (owner design, 2026-11-01), server side: the prompt it
 * builds, and the route handler's gates and storage. A scripted pi engine (the
 * faux provider) stands in for the chat's conversation model; the handler's
 * engineOverride seam takes it as the third argument. Runs under an isolated
 * LH_DATA_DIR (the chat-store-events discipline: the seam is set before any
 * config-loading import, so the app modules are dynamic imports).
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

const { clarifyPrompt, handleClarifyRead, handleClarifyRequest } = await import("../src/server/clarify.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { pendingQuestionOf } = await import("../src/core/native-messages.ts");
const { CLARIFY_QUESTION_MAX, CLARIFY_QUOTE_MAX } = await import("../src/core/contracts/chat.ts");
const { agentSystemPrompt } = await import("../src/agent/teacher-agent.ts");
const { effectiveSettings } = await import("../src/server/stores.ts");
const { resolvePace } = await import("../src/core/pace.ts");
const { resolveLessonLanguage } = await import("../src/core/language.ts");
const { materialsForTurn } = await import("../src/server/materials.ts");
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

/** A chat whose history ends in an unanswered quiz (the pending question). */
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
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			content: [
				{ type: "text", text: "Let's check the basics." },
				{ type: "toolCall", id: "call-1", name: "quiz", arguments: QUIZ_INPUT },
			],
		} as never,
	]);
	return chat;
}

function keyOf(chatId: string): string {
	const pending = pendingQuestionOf(chatStore.getChat(chatId)!.messages);
	assert.ok(pending, "the fixture has a pending question");
	return pending.key;
}

function post(chatId: string, body: unknown): Promise<Response> {
	return handleClarifyRequest(chatId, body, undefined);
}

describe("clarifyPrompt — the call's one instruction", () => {
	it("carries the marked text, the question, and the never-reveal rule", () => {
		const text = clarifyPrompt({ quote: "the inner planets", question: "what does inner mean?", earlier: [] });
		assert.ok(text.includes("the inner planets"), "the marked text");
		assert.ok(text.includes("what does inner mean?"), "the question");
		assert.ok(text.includes("Do NOT state"), "the never-reveal rule is stated");
		assert.ok(text.includes("pending question"), "it names the pending question");
	});

	it("includes every earlier pair", () => {
		const text = clarifyPrompt({
			quote: "third passage",
			question: "third question?",
			earlier: [
				{ quote: "first passage", question: "first question?", reply: "first reply" },
				{ quote: "second passage", question: "second question?", reply: "second reply" },
			],
		});
		for (const s of ["first passage", "first question?", "first reply", "second passage", "second question?", "second reply", "third passage", "third question?"]) {
			assert.ok(text.includes(s), `contains ${s}`);
		}
		assert.ok(text.includes("Earlier clarifications"), "the earlier section is present");
	});

	it("has no earlier section with no earlier pairs", () => {
		const text = clarifyPrompt({ quote: "q", question: "question?", earlier: [] });
		assert.equal(text.includes("Earlier clarifications"), false);
	});
});

describe("handleClarifyRequest — the gates", () => {
	it("400 for a missing key, an empty quote, an empty question, and over-long input", async () => {
		const chat = pendingChat("Clarify gates 400");
		const key = keyOf(chat.id);
		assert.equal((await post(chat.id, { quote: "x", question: "y" })).status, 400, "missing key");
		assert.equal((await post(chat.id, { key, quote: "   ", question: "y" })).status, 400, "empty quote");
		assert.equal((await post(chat.id, { key, quote: "x", question: "  " })).status, 400, "empty question");
		assert.equal((await post(chat.id, { key, quote: "a".repeat(CLARIFY_QUOTE_MAX + 1), question: "y" })).status, 400, "over-long quote");
		assert.equal((await post(chat.id, { key, quote: "x", question: "q".repeat(CLARIFY_QUESTION_MAX + 1) })).status, 400, "over-long question");
	});

	it("404 for an unknown chat", async () => {
		const res = await post("chat_never_existed", { key: "call-1", quote: "x", question: "y" });
		assert.equal(res.status, 404);
	});

	it("409 when the key does not match the pending question", async () => {
		const chat = pendingChat("Clarify gates key");
		const res = await post(chat.id, { key: "some-other-call", quote: "x", question: "y" });
		assert.equal(res.status, 409);
	});

	it("409 when no question is pending", async () => {
		const chat = chatStore.createChat("Clarify gates none");
		chatStore.saveMessages(chat.id, [{ id: "m_user", role: "user", content: "hello", timestamp: 1 } as never]);
		const res = await post(chat.id, { key: "call-1", quote: "x", question: "y" });
		assert.equal(res.status, 409);
	});
});

describe("handleClarifyRequest — the answer", () => {
	it("200 with the clarification; stored in the side thread; messages untouched", async () => {
		const chat = pendingChat("Clarify success");
		const key = keyOf(chat.id);
		const before = chatStore.getChat(chat.id)!;
		const messagesBefore = JSON.stringify(before.messages);
		const { engine } = scripted([reply("Inner means the planets nearest the sun.")]);

		const res = await handleClarifyRequest(chat.id, { key, quote: "  the inner planets  ", question: "what does inner mean?" }, engine);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { clarification: { id: string; quote: string; question: string; reply: string; at: string } };
		const c = body.clarification;
		assert.equal(typeof c.id, "string");
		assert.equal(c.quote, "the inner planets", "the quote is trimmed");
		assert.equal(c.question, "what does inner mean?");
		assert.equal(c.reply, "Inner means the planets nearest the sun.");
		assert.equal(typeof c.at, "string");

		const after = chatStore.getChat(chat.id)!;
		assert.deepEqual(after.clarifications?.[key]?.map((x) => x.id), [c.id], "stored under the pending key");
		assert.equal(after.messages.length, before.messages.length, "messages length unchanged");
		assert.deepEqual(after.messages.map((m) => m.id), before.messages.map((m) => m.id), "message ids unchanged");
		assert.equal(JSON.stringify(after.messages), messagesBefore, "messages unchanged");
	});

	it("the engine got the prober system prompt and NO tools", async () => {
		const chat = pendingChat("Clarify context");
		const key = keyOf(chat.id);
		const { engine, contexts } = scripted([reply("A short explanation.")]);
		const res = await handleClarifyRequest(chat.id, { key, quote: "passage", question: "why?" }, engine);
		assert.equal(res.status, 200);
		const ctx = contexts[0];
		assert.ok(ctx, "the engine was called once");
		const expected = agentSystemPrompt("prober", {
			promptSwitches: effectiveSettings().agent.prompts,
			language: resolveLessonLanguage(chatStore.getChat(chat.id)!.settings),
			pace: { level: resolvePace(chatStore.getChat(chat.id)!.settings) },
			materials: materialsForTurn(chat.id),
		});
		// The faux context folds the system prompt into a leading system message.
		const system = (ctx.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === "system");
		assert.equal(system?.content, expected, "the prober system prompt");
		assert.ok(!ctx.tools || ctx.tools.length === 0, "no tools were offered");
	});

	it("a second ask passes the first pair in the prompt text", async () => {
		const chat = pendingChat("Clarify second ask");
		const key = keyOf(chat.id);
		const { engine, contexts } = scripted([reply("First answer."), reply("Second answer.")]);
		await handleClarifyRequest(chat.id, { key, quote: "first passage", question: "first question?" }, engine);
		const res = await handleClarifyRequest(chat.id, { key, quote: "second passage", question: "second question?" }, engine);
		assert.equal(res.status, 200);
		const lastPrompt = JSON.stringify(contexts[1].messages);
		assert.ok(lastPrompt.includes("first question?"), "the earlier question is in the prompt");
		assert.ok(lastPrompt.includes("First answer."), "the earlier reply is in the prompt");
		const thread = chatStore.getChat(chat.id)!.clarifications?.[key];
		assert.equal(thread?.length, 2, "both pairs are stored");
	});

	it("an engine that throws → 502 and nothing stored", async () => {
		const chat = pendingChat("Clarify throws");
		const key = keyOf(chat.id);
		const { engine } = scripted([() => { throw new Error("upstream down"); }]);
		const res = await handleClarifyRequest(chat.id, { key, quote: "x", question: "y" }, engine);
		assert.equal(res.status, 502);
		assert.equal(chatStore.getChat(chat.id)!.clarifications?.[key], undefined);
	});

	it("an empty reply → 502 and nothing stored", async () => {
		const chat = pendingChat("Clarify empty");
		const key = keyOf(chat.id);
		const { engine } = scripted([reply("   ")]);
		const res = await handleClarifyRequest(chat.id, { key, quote: "x", question: "y" }, engine);
		assert.equal(res.status, 502);
		assert.equal(chatStore.getChat(chat.id)!.clarifications?.[key], undefined);
	});
});

describe("handleClarifyRead", () => {
	it("returns the stored thread, and [] for an unknown key", async () => {
		const chat = pendingChat("Clarify read");
		const key = keyOf(chat.id);
		const { engine } = scripted([reply("Read me back.")]);
		await handleClarifyRequest(chat.id, { key, quote: "p", question: "q?" }, engine);

		const res = handleClarifyRead(chat.id, key);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { clarifications: Array<{ question: string; reply: string }> };
		assert.equal(body.clarifications.length, 1);
		assert.equal(body.clarifications[0]!.question, "q?");
		assert.equal(body.clarifications[0]!.reply, "Read me back.");

		const none = (await handleClarifyRead(chat.id, "no-such-key").json()) as { clarifications: unknown[] };
		assert.deepEqual(none.clarifications, []);
	});
});
