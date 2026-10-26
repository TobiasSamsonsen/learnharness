/**
 * Practice-flow integration test (practice sessions, owner design
 * 2026-10-04) — the full practice loop with zero tokens, mirroring
 * chat-flow.test.ts's harness (handleChatRequest + the faux engine):
 *
 *   learner opens → practice agent poses (problem, terminate) → thinking
 *   arrives as a labeled message → agent concludes + reveals + wraps
 *   → Esc dismissal synthesizes the conclude pair on the next input.
 *
 * The record law under pin: the pose ack PERSISTS (unlike a question's
 * placeholder) and a record ending on it owes no continuation.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseFactory,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createPracticeAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { activeProblemOf, needsContinuation } from "../src/core/index.ts";
import { PATHS } from "../config.ts";
import { CONCLUDE_ACK_TEXT } from "../src/core/contracts/chat.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

// The BYOK key-presence gate reads env-first (chat-flow.test.ts's idiom).
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

/** A valid problem pose — the slim schema: statement, mode, target,
 *  modelSolution (the commitment, which is also the reveal). */
const POSE = {
	statement: "Prove that every finite group of prime order is cyclic.",
	mode: "recall",
	target: ["group-order"],
	modelSolution: "Let |G| = p. Any x ≠ e generates a subgroup whose order divides p…",
} as const;

/** A valid conclude — no reveal field; the pose's modelSolution is the reveal. */
const CONCLUDE = {
	outcome: "solved",
	verdict: "The subgroup-order argument is credited in full.",
	rung: null,
	missClass: null,
	retest: false,
} as const;

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

function createPracticeChat(title: string) {
	const chat = chatStore.createChat(title, "practice");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	createdChats.push(chat.id);
	return chat;
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

async function drain(res: Response): Promise<string> {
	if (res.status !== 200) {
		assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	}
	return res.text();
}

/** CONNECTION DIET B (owner, 2026-10-10): POST acks and closes; the turn's
 *  wire is the reattach stream. Mirrors drain(): 200-ack assert + the fully
 *  drained SSE body via runningTurn + subscribe (subscribe immediately —
 *  faux turns settle in microtask rounds). */
async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<string> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) {
		assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	}
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (!handle) return ""; // the turn settled inside the handler — completion already happened
	return new Response(handle.subscribe()).text();
}

/** The practice agent factory (the handler's kind branch, test-shaped). */
function practiceFactory(chatId: string, engine: PiEngine): Parameters<typeof handleChatRequest>[1] {
	return (opts) => createPracticeAgent({ chatId, chatStore }, { engine, messages: opts.messages });
}

/** Each step records the prompt it received — the transcript the model
 *  saw (the chat-flow capture idiom). */
function scripted(steps: FauxResponseStep[]): { engine: PiEngine; calls: string[] } {
	const calls: string[] = [];
	const faux = createFauxCore({});
	const wrap = (step: FauxResponseStep) =>
		async (context: TranscriptContext): Promise<AssistantMessage> => {
			calls.push(
				context.messages.map((m) => JSON.stringify((m as { content?: unknown }).content)).join("\n"),
			);
			return typeof step === "function"
				? await (step as FauxResponseFactory)(context, undefined, undefined as never, undefined as never)
				: step;
		};
	faux.setResponses(steps.map(wrap));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

const lastSaw = (calls: string[], needle: string) => calls[calls.length - 1]!.includes(needle);

describe("practice flow (scripted model)", () => {
	it("pose → thinking commit → conclude + reveal; the pose ack persists and owes nothing", async () => {
		const chat = createPracticeChat("Test: practice groups");
		const { engine, calls } = scripted([
			// Turn 1: the agent poses immediately (terminate:true ends the run).
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-p1" })], { stopReason: "toolUse" }),
			// Turn 2 (after the commit): conclude (non-terminating) …
			() => fauxAssistantMessage([fauxToolCall("conclude", CONCLUDE, { id: "call-c1" })], { stopReason: "toolUse" }),
			// … the loop continues: reveal text ends the turn.
			() => fauxAssistantMessage([fauxText("Clean proof. Ready for the next one?")]),
		]);
		const factory = practiceFactory(chat.id, engine);

		// ── Turn 1: the opening text; the agent poses ──
		await drainTurn(post(chat.id, { type: "text", text: "practice group theory" }), factory);
		const afterPose = chatStore.getChat(chat.id)!.messages;
		const ack = afterPose[afterPose.length - 1] as LhMessage & ToolResultMessage;
		assert.equal(ack.role, "toolResult");
		assert.equal(ack.toolName, "problem");
		assert.equal(ack.isError, false);
		assert.equal(needsContinuation(afterPose), false);
		assert.equal(activeProblemOf(afterPose)?.toolCallId, "call-p1");

		// ── Turn 2: the submission arrives as a single-lane thinking message ──
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-p1", text: "|G|=p; ⟨x⟩ has order dividing p" }), factory);
		// The model saw the one label (owner round 2, 2026-10-05): the
		// register is read from the text, not declared by a button.
		assert.ok(lastSaw(calls, "Your thinking:"), "the conclude turn's prompt carries the thinking");
		const afterConclude = chatStore.getChat(chat.id)!.messages;
		const concludeAck = afterConclude.find(
			(m) => (m as ToolResultMessage).role === "toolResult" && (m as ToolResultMessage).toolName === "conclude",
		) as LhMessage & ToolResultMessage;
		assert.ok(concludeAck, "the conclude ack persisted");
		// Owner round 16: the ack carries the turn-ends law (no more tools,
		// the learner's go-ahead paces the next problem).
		assert.ok((concludeAck.content[0] as { text: string }).text.includes("END YOUR TURN"));
		// The turn continued past conclude to the reveal text.
		assert.ok(afterConclude.some((m) => (m as { role?: string }).role === "assistant" && JSON.stringify((m as { content?: unknown }).content).includes("Clean proof.")));
		assert.equal(activeProblemOf(afterConclude), null);
	});

	it("a working-trace submission keeps the problem active", async () => {
		const chat = createPracticeChat("Test: practice nudge");
		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-p2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("R0: reread the subgroup constraint.")]),
		]);
		const factory = practiceFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-p2", text: "stuck at the second step" }), factory);
		assert.ok(lastSaw(calls, "Your thinking:"), "the turn's prompt carries the thinking");
		// The problem is still active — a trace never concludes.
		assert.equal(activeProblemOf(chatStore.getChat(chat.id)!.messages)?.toolCallId, "call-p2");
	});

	it("Esc dismissal marks silently; the next input rides the synthesized conclude pair", async () => {
		const chat = createPracticeChat("Test: practice dismiss");
		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-p3" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Dropped. Something else, then.")]),
		]);
		const factory = practiceFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);

		// The silent dismissal route (the same POST the client's Esc takes).
		const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");
		const dismissRes = await dismissRoute.POST(
			new Request(`http://test/api/chats/${chat.id}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "dismiss-problem", problemCallId: "call-p3" } }),
			}),
			{ params: Promise.resolve({ id: chat.id }) },
		);
		assert.equal(dismissRes.status, 200);
		const marked = chatStore.getChat(chat.id)!.messages;
		assert.equal(activeProblemOf(marked), null, "the marker deactivates at Esc time");

		// The next plain input synthesizes the conclude pair ahead of itself.
		await drainTurn(post(chat.id, { type: "text", text: "something easier" }), factory);
		const msgs = chatStore.getChat(chat.id)!.messages;
		const synth = msgs.find(
			(m) => (m as ToolResultMessage).role === "toolResult" && (m as ToolResultMessage).toolName === "conclude",
		) as (LhMessage & ToolResultMessage) | undefined;
		assert.ok(synth, "the synthesized conclude result persisted");
		assert.ok(
			(synth.content[0] as { text: string }).text.includes(CONCLUDE_ACK_TEXT),
			"the pair carries the shared conclude ack text",
		);
		assert.ok(lastSaw(calls, "dismissed"), "the model saw the dismissed outcome");
	});
});

// ─── sketch submissions (Android plan M1, 2026-10-26) ───────────────────────

describe("practice flow — sketch submissions", () => {
	/** A two-row handwritten sketch: [x, y, pressure] triples. */
	const SKETCH = {
		id: "sk_flowtest00000001",
		producer: "web-canvas",
		strokes: [
			{ size: 4, points: [10, 10, 0.5, 80, 40, 0.6, 160, 20, 0.5, 240, 60, 0.5] },
			{ size: 4, points: [10, 120, 0.5, 200, 130, 0.5] },
		],
	};
	const sketchDir = (chatId: string) => path.join(PATHS.sketches, chatId);
	after(() => {
		for (const id of createdChats) fs.rmSync(sketchDir(id), { recursive: true, force: true });
	});
	/** The handler's practice branch, with the sketch resolver wired. */
	const sketchFactory = (chatId: string, engine: PiEngine): Parameters<typeof handleChatRequest>[1] =>
		(opts) => createPracticeAgent({ chatId, chatStore }, { engine, messages: opts.messages, sketchImages: opts.sketchImages });

	it("a sketch-only submission stores its pages and reaches the model as an image", async () => {
		const chat = createPracticeChat("Test: practice sketch");
		const seen: unknown[][] = [];
		const { engine } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-s1" })], { stopReason: "toolUse" }),
			(context) => {
				seen.push(context.messages.map((m) => (m as { content?: unknown }).content));
				return fauxAssistantMessage([fauxText("I see your two lines.")]);
			},
		]);
		const factory = sketchFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-s1", text: "", sketch: SKETCH }), factory);

		const png = fs.readFileSync(path.join(sketchDir(chat.id), SKETCH.id, "0.png"));
		assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "a real PNG");
		assert.ok(fs.existsSync(path.join(sketchDir(chat.id), SKETCH.id, "0.svg")));
		assert.ok(fs.existsSync(path.join(sketchDir(chat.id), SKETCH.id, "strokes.json")));

		const marker = chatStore.getChat(chat.id)!.messages.find((m) => (m as { customType?: string }).customType === "practice-thinking");
		const details = (marker as { details: { sketch?: { id: string }; text: string } }).details;
		assert.equal(details.sketch?.id, SKETCH.id, "the record keeps the ref");
		assert.ok(!JSON.stringify(chatStore.getChat(chat.id)).includes("iVBOR"), "never the bytes");

		const last = seen.at(-1)!.at(-1) as Array<{ type: string; data?: string }>;
		assert.deepEqual(last.map((b) => b.type), ["text", "image", "text"], "the page leads the thinking");
		assert.equal(Buffer.from(last[1]!.data!, "base64").subarray(0, 4).toString("hex"), "89504e47");
	});

	it("a kept page re-sent by id reuses the stored sketch; an unknown id is a 400", async () => {
		const chat = createPracticeChat("Test: practice sketch ref");
		const { engine } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-s4" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("I see your two lines.")]),
			() => fauxAssistantMessage([fauxText("Still the same page.")]),
		]);
		const factory = sketchFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-s4", text: "first", sketch: SKETCH }), factory);
		const png = path.join(sketchDir(chat.id), SKETCH.id, "0.png");
		const before = fs.statSync(png).mtimeMs;

		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-s4", text: "again", sketchRef: SKETCH.id }), factory);
		const markers = chatStore.getChat(chat.id)!.messages.filter((m) => (m as { customType?: string }).customType === "practice-thinking");
		const ids = markers.map((m) => (m as { details: { sketch?: { id: string } } }).details.sketch?.id);
		assert.deepEqual(ids, [SKETCH.id, SKETCH.id], "both submissions carry the page");
		assert.equal(fs.statSync(png).mtimeMs, before, "the stored page is not rewritten");

		const res = await handleChatRequest(post(chat.id, { type: "thinking", problemCallId: "call-s4", text: "x", sketchRef: "sk_doesnotexist0001" }), factory);
		assert.equal(res.status, 400);
	});

	it("a bad sketch is a 400 and nothing is written", async () => {
		const chat = createPracticeChat("Test: practice sketch 400");
		const { engine } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-s2" })], { stopReason: "toolUse" }),
		]);
		const factory = sketchFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		const before = chatStore.getChat(chat.id)!.messages.length;
		const res = await handleChatRequest(
			post(chat.id, { type: "thinking", problemCallId: "call-s2", text: "x", sketch: { ...SKETCH, strokes: [{ size: 4, points: [1, 2] }] } }),
			factory,
		);
		assert.equal(res.status, 400);
		assert.equal(chatStore.getChat(chat.id)!.messages.length, before, "the record is unchanged");
		assert.ok(!fs.existsSync(sketchDir(chat.id)), "no sketch on disk");
	});

	it("a sketch that cannot be stored refuses the input before the write-ahead", async () => {
		const chat = createPracticeChat("Test: practice sketch store failure");
		const { engine } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-s3" })], { stopReason: "toolUse" }),
		]);
		const factory = sketchFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		const before = chatStore.getChat(chat.id)!.messages.length;
		// A FILE where the chat's sketch folder belongs: the store's mkdir fails.
		fs.mkdirSync(PATHS.sketches, { recursive: true });
		fs.writeFileSync(sketchDir(chat.id), "blocker");
		try {
			const res = await handleChatRequest(post(chat.id, { type: "thinking", problemCallId: "call-s3", text: "x", sketch: SKETCH }), factory);
			assert.equal(res.status, 500);
			assert.equal(chatStore.getChat(chat.id)!.messages.length, before, "the record never names a missing sketch");
		} finally {
			fs.rmSync(sketchDir(chat.id), { force: true });
		}
	});
});

// ─── sketch readings (Android plan M2, 2026-10-26) ──────────────────────────

describe("practice flow — sketch readings", () => {
	const SKETCH = {
		id: "sk_readingflow00001",
		producer: "web-canvas",
		strokes: [{ size: 4, points: [10, 10, 0.5, 80, 40, 0.6, 160, 20, 0.5, 240, 60, 0.5] }],
	};
	after(() => {
		for (const id of createdChats) fs.rmSync(path.join(PATHS.sketches, id), { recursive: true, force: true });
	});
	const sketchFactory = (chatId: string, engine: PiEngine): Parameters<typeof handleChatRequest>[1] =>
		(opts) => createPracticeAgent({ chatId, chatStore }, { engine, messages: opts.messages, sketchImages: opts.sketchImages });
	const results = (chatId: string, tool: string) =>
		chatStore.getChat(chatId)!.messages.filter((m) => (m as ToolResultMessage).role === "toolResult" && (m as ToolResultMessage).toolName === tool) as Array<LhMessage & ToolResultMessage>;
	const text = (m: ToolResultMessage) => (m.content[0] as { text: string }).text;

	it("a solved conclude is refused until the sketch is read; [read_sketch, conclude] in one reply goes through", async () => {
		const chat = createPracticeChat("Test: sketch gate");
		const { engine } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-g1" })], { stopReason: "toolUse" }),
			// The model skips the read and grades straight away…
			() => fauxAssistantMessage([fauxToolCall("conclude", CONCLUDE, { id: "call-c1" })], { stopReason: "toolUse" }),
			// …is refused, and does it properly: read first, conclude after, one reply.
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall("read_sketch", { sketchId: SKETCH.id, reading: "$|G| = p$, then $\langle x \rangle$", uncertain: [] }, { id: "call-s1" }),
						fauxToolCall("conclude", CONCLUDE, { id: "call-c2" }),
					],
					{ stopReason: "toolUse" },
				),
			() => fauxAssistantMessage([fauxText("Clean proof.")]),
		]);
		const factory = sketchFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-g1", text: "", sketch: SKETCH }), factory);

		const concludes = results(chat.id, "conclude");
		assert.equal(concludes.length, 2);
		assert.equal(concludes[0]!.isError, true, "the unread conclude is refused");
		assert.match(text(concludes[0]!), /unread — call read_sketch/);
		assert.equal(concludes[1]!.isError, false, "the batched one goes through");
		const reads = results(chat.id, "read_sketch");
		assert.equal(reads.length, 1);
		assert.equal(reads[0]!.isError, false);
		assert.equal(activeProblemOf(chatStore.getChat(chat.id)!.messages), null, "only the clean conclude freed the problem");
	});

	it("a mark settled against the committed answer concludes at once — no refusal, no question", async () => {
		const chat = createPracticeChat("Test: sketch settled");
		const { engine } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-t1" })], { stopReason: "toolUse" }),
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall("read_sketch", { sketchId: SKETCH.id, reading: "$|G| = p$", uncertain: [], settled: ["the exponent: 2 or 3; took 2, the committed answer"] }, { id: "call-s1" }),
						fauxToolCall("conclude", CONCLUDE, { id: "call-c1" }),
					],
					{ stopReason: "toolUse" },
				),
			() => fauxAssistantMessage([fauxText("I took the unclear exponent as 2. Clean proof.")]),
		]);
		const factory = sketchFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-t1", text: "", sketch: SKETCH }), factory);
		const concludes = results(chat.id, "conclude");
		assert.equal(concludes.length, 1);
		assert.equal(concludes[0]!.isError, false, "settled marks do not block the gate");
		assert.equal(activeProblemOf(chatStore.getChat(chat.id)!.messages), null);
	});

	it("open doubts end the turn with no paragraph — even beside a refused conclude — and the clarification brings it", async () => {
		const chat = createPracticeChat("Test: sketch doubt stop");
		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-u1" })], { stopReason: "toolUse" }),
			// The model reads with a doubt AND tries to conclude in the same batch...
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall("read_sketch", { sketchId: SKETCH.id, reading: "$x^?$", uncertain: ["the exponent: 2 or 3"] }, { id: "call-s1" }),
						fauxToolCall("conclude", CONCLUDE, { id: "call-c1" }),
					],
					{ stopReason: "toolUse" },
				),
			// (No step here: the turn must end after the batch — the call count below
			// proves no further model call was made.)
			// After the learner clarifies:
			() => fauxAssistantMessage([fauxToolCall("read_sketch", { sketchId: SKETCH.id, reading: "$x^2$", uncertain: [] }, { id: "call-s2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("conclude", CONCLUDE, { id: "call-c2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Verified: x squared. Clean proof.")]),
		]);
		const factory = sketchFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-u1", text: "", sketch: SKETCH }), factory);

		const afterFirst = chatStore.getChat(chat.id)!.messages;
		assert.equal(calls.length, 2, "pose + the doubtful read: no third model call");
		assert.equal(
			afterFirst.filter((m) => (m as { role?: string }).role === "assistant" && JSON.stringify(m).includes('"type":"text"')).length,
			0,
			"no assistant prose at all",
		);
		assert.equal((afterFirst.at(-1) as ToolResultMessage).role, "toolResult", "the turn ends on the tool results — no paragraph");
		assert.equal(needsContinuation(afterFirst), false, "and a reload owes nothing");
		assert.equal(activeProblemOf(afterFirst)?.toolCallId, "call-u1", "the refused conclude left the problem active");

		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-u1", text: "it's x squared" }), factory);
		const messages = chatStore.getChat(chat.id)!.messages;
		assert.equal(activeProblemOf(messages), null, "verified, then concluded");
		const last = messages.at(-1) as { role: string; content: Array<{ text?: string }> };
		assert.equal(last.role, "assistant");
		assert.match(last.content[0]!.text!, /Verified: x squared/, "the paragraph came after verification");
	});

	it("a dispute is a recorded input: the marker lands, the model re-reads", async () => {
		const chat = createPracticeChat("Test: sketch dispute");
		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-d1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("read_sketch", { sketchId: SKETCH.id, reading: "$x^2$", uncertain: [] }, { id: "call-s1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("You wrote x squared; that step holds.")]),
			// After the dispute:
			() => fauxAssistantMessage([fauxToolCall("read_sketch", { sketchId: SKETCH.id, reading: "$x^3$", uncertain: [] }, { id: "call-s2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Thanks — x cubed. Then the step fails.")]),
		]);
		const factory = sketchFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-d1", text: "see sketch", sketch: SKETCH }), factory);

		// A dispute of an unknown / unread sketch is a 400 and changes nothing.
		const before = chatStore.getChat(chat.id)!.messages.length;
		const bad = await handleChatRequest(post(chat.id, { type: "dispute", sketchId: "sk_neverreadsketch01" }), factory);
		assert.equal(bad.status, 400);
		assert.equal(chatStore.getChat(chat.id)!.messages.length, before);

		await drainTurn(post(chat.id, { type: "dispute", sketchId: SKETCH.id, text: "it was x^3" }), factory);
		const messages = chatStore.getChat(chat.id)!.messages;
		const marker = messages.find((m) => (m as { customType?: string }).customType === "sketch-dispute") as unknown as { details: { sketchId: string; text: string } };
		assert.deepEqual(marker.details, { sketchId: SKETCH.id, text: "it was x^3" });
		assert.ok(lastSaw(calls.slice(0, calls.length - 1), "says your reading of sketch"), "the model saw the dispute before re-reading");
		assert.equal(results(chat.id, "read_sketch").length, 2, "it read again");
		assert.equal(activeProblemOf(messages)?.toolCallId, "call-d1", "the problem is still active");
	});
});
