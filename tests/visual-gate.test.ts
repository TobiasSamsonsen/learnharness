/**
 * The visual decision (owner, 2026-11-10 — the ε-δ lesson on the tablet: across
 * 14 chats the tutor called `demo` once, on request, and `visual` never).
 * plan_init carries a required `visual` decision; when it calls for a picture,
 * the first teach question is refused until a visual or demo job is dispatched.
 * The pure rule, the live wiring, and the plan_init field itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, validateToolArguments, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { VISUAL_GATE_REASON, visualGateBlocks } from "../src/core/visual-gate.ts";
import { bareQuestionTools, createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { planTools } from "../src/agent/tools/plan.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "faux",
	provider: "faux",
	model: "faux",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse",
	timestamp: 1,
});
const text = (t: string) => ({ type: "text" as const, text: t });
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall" as const, id, name, arguments: args as ToolCall["arguments"] });
const ok = (toolCallId: string, toolName: string) => ({ role: "toolResult" as const, toolCallId, toolName, content: [text("ok")], isError: false, timestamp: 1 });
const failed = (toolCallId: string, toolName: string) => ({ ...ok(toolCallId, toolName), isError: true });

const MERMAID = "graph TD\n  a[A] --> b[B]\n";
const planCall = (id: string, visual?: Record<string, unknown>) => toolCall(id, "plan_init", { mermaid: MERMAID, ...(visual ? { visual } : {}) });
const user = (content: string) => ({ role: "user", content, timestamp: 0 });
const demoCall = (id: string) => toolCall(id, "demo", { title: "ε-δ", brief: "A graph with an ε-band and a δ-window." });

/** A chat whose plan has just been accepted by the learner. */
const planned = (visual?: Record<string, unknown>) => [user("teach me"), assistant([planCall("p1", visual)]), ok("p1", "plan_init"), user("dette passer greit")];
const WITH_TOOLS = ["quiz", "explain", "demo", "visual", "send_to_user"];
const DEMO = { use: "demo", reason: "sweep ε and watch the δ-window" };
const VISUAL = { use: "visual", reason: "the ε-band and δ-window around f at x0" };
const NONE = { use: "none", reason: "a purely algebraic identity" };

describe("visualGateBlocks (the pure rule)", () => {
	it("refuses the first teach question while the plan calls for a picture and none is dispatched", () => {
		assert.equal(visualGateBlocks(planned(DEMO), "quiz", WITH_TOOLS), true);
		assert.equal(visualGateBlocks(planned(VISUAL), "quiz", WITH_TOOLS), true);
		assert.equal(visualGateBlocks(planned(VISUAL), "explain", WITH_TOOLS), true);
	});

	it("passes once a visual or demo job is dispatched, whichever the plan named", () => {
		const dispatched = (name: string) => [...planned(VISUAL), assistant([toolCall("v1", name, {})]), ok("v1", name)];
		assert.equal(visualGateBlocks(dispatched("visual"), "quiz", WITH_TOOLS), false);
		assert.equal(visualGateBlocks(dispatched("demo"), "quiz", WITH_TOOLS), false);
	});

	it("a dispatch that failed (an error result) dispatched nothing", () => {
		const history = [...planned(DEMO), assistant([demoCall("v1")]), failed("v1", "demo")];
		assert.equal(visualGateBlocks(history, "quiz", WITH_TOOLS), true);
	});

	it("`none` (with its reason), a plan without the field, and no plan at all are never gated", () => {
		assert.equal(visualGateBlocks(planned(NONE), "quiz", WITH_TOOLS), false);
		assert.equal(visualGateBlocks(planned(), "quiz", WITH_TOOLS), false, "an old plan_init call has no `visual`");
		assert.equal(visualGateBlocks([user("teach me")], "quiz", WITH_TOOLS), false);
	});

	it("only the newest successful plan counts; a failed plan_init is ignored", () => {
		const rewrittenToNone = [...planned(DEMO), assistant([planCall("p2", NONE)]), ok("p2", "plan_init")];
		assert.equal(visualGateBlocks(rewrittenToNone, "quiz", WITH_TOOLS), false, "the learner's plan was rewritten to none");
		const rewriteFailed = [...planned(DEMO), assistant([planCall("p2", NONE)]), failed("p2", "plan_init")];
		assert.equal(visualGateBlocks(rewriteFailed, "quiz", WITH_TOOLS), true, "the failed rewrite never took effect");
		const rewrittenToDemo = [...planned(NONE), assistant([planCall("p2", DEMO)]), ok("p2", "plan_init")];
		assert.equal(visualGateBlocks(rewrittenToDemo, "quiz", WITH_TOOLS), true);
	});

	it("applies to teach questions only", () => {
		for (const tool of ["ask_user_question", "probe", "recall", "read_sketch", "send_to_user", "demo", "visual", "plan_init"]) {
			assert.equal(visualGateBlocks(planned(DEMO), tool, WITH_TOOLS), false, tool);
		}
	});

	it("never deadlocks a tutor that has neither picture tool", () => {
		assert.equal(visualGateBlocks(planned(DEMO), "quiz", ["quiz", "explain"]), false);
		assert.equal(visualGateBlocks(planned(DEMO), "quiz", ["quiz", "visual"]), true, "either tool satisfies it");
	});

	it("the refusal tells the tutor both ways out", () => {
		assert.match(VISUAL_GATE_REASON, /`visual`/);
		assert.match(VISUAL_GATE_REASON, /`demo`/);
		assert.match(VISUAL_GATE_REASON, /`none`/);
	});
});

describe("the visual gate is live in the teacher", () => {
	const demoTool: AgentTool<any> = {
		name: "demo",
		label: "demo",
		description: "test demo",
		parameters: Type.Object({ title: Type.String(), brief: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "Dispatched" }], details: {} }),
	};
	const quiz = (lead: string) => ({
		type: "predict",
		nodeId: "n1",
		lead,
		question: "What is $2+2$?",
		explanation: "$2+2=4$.",
		options: [
			{ label: "$4$", value: "a" },
			{ label: "$5$", value: "b" },
		],
		correctAnswer: "a",
	});
	type ToolResultLike = { toolCallId: string; isError: boolean; content: Array<{ text?: string }> };

	it("a quiz before the planned demo comes back refused; the demo, then the quiz, go through", async () => {
		const faux = createFauxCore({});
		faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall("quiz", quiz("Vi starter her.") as ToolCall["arguments"], { id: "q1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("demo", demoCall("d1").arguments as ToolCall["arguments"], { id: "d1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("quiz", quiz("Se på figuren: båndet rundt $f(x_0)$.") as ToolCall["arguments"], { id: "q2" })], { stopReason: "toolUse" }),
		]);
		const agent = createTeacherAgent(undefined, {
			engine: { model: { ...faux.getModel(), provider: "claude-code" }, streamFn: faux.streamSimple },
			tools: { ...bareQuestionTools(), demo: demoTool },
			messages: planned(DEMO) as never,
		});
		await agent.continue();
		const results = agent.state.messages.filter((m) => (m as { role?: string }).role === "toolResult") as ToolResultLike[];
		const refused = results.find((r) => r.toolCallId === "q1")!;
		assert.equal(refused.isError, true);
		assert.equal(refused.content[0]!.text, VISUAL_GATE_REASON);
		assert.equal(results.find((r) => r.toolCallId === "d1")!.isError, false, "the demo is dispatched");
		assert.equal(results.find((r) => r.toolCallId === "q2")!.isError, false, "the quiz after it is posed");
	});

	it("with `none` the first quiz is posed straight away", async () => {
		const faux = createFauxCore({});
		faux.setResponses([() => fauxAssistantMessage([fauxToolCall("quiz", quiz("Vi starter her.") as ToolCall["arguments"], { id: "q1" })], { stopReason: "toolUse" })]);
		const agent = createTeacherAgent(undefined, {
			engine: { model: { ...faux.getModel(), provider: "claude-code" }, streamFn: faux.streamSimple },
			tools: { ...bareQuestionTools(), demo: demoTool },
			messages: planned(NONE) as never,
		});
		await agent.continue();
		const results = agent.state.messages.filter((m) => (m as { role?: string }).role === "toolResult") as ToolResultLike[];
		assert.equal(results.find((r) => r.toolCallId === "q1")!.isError, false);
	});
});

describe("plan_init carries the visual decision", () => {
	const chat = chatStore.createChat("Plan: visual decision");
	after(() => {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${chat.id}.json`));
		} catch {
			/* already gone */
		}
	});
	const tools = planTools({ chatId: chat.id, chatStore });
	const planInit = tools.plan_init!;
	const validate = (args: unknown) => validateToolArguments(planInit as never, { id: "c", type: "toolCall", name: "plan_init", arguments: args } as never);

	it("the schema requires it, with a known `use` and a non-empty reason", () => {
		assert.throws(() => validate({ mermaid: MERMAID }), /visual/);
		assert.throws(() => validate({ mermaid: MERMAID, visual: { use: "maybe", reason: "x" } }));
		assert.throws(() => validate({ mermaid: MERMAID, visual: { use: "demo", reason: "" } }));
		for (const visual of [DEMO, VISUAL, NONE]) assert.doesNotThrow(() => validate({ mermaid: MERMAID, visual }));
	});

	it("the result reminds the tutor what to do next, per choice", async () => {
		const run = async (visual?: Record<string, unknown>) => {
			const result = await planInit.execute("t", { mermaid: MERMAID, ...(visual ? { visual } : {}) } as never);
			return JSON.parse((result.content[0] as { text: string }).text) as { ok: boolean; reminder: string; visualReminder?: string };
		};
		const demo = await run(DEMO);
		assert.equal(demo.ok, true);
		assert.match(demo.visualReminder!, /dispatch it now/);
		assert.match(demo.visualReminder!, /refused until/);
		assert.match((await run(VISUAL)).visualReminder!, /dispatch it now/);
		assert.match((await run(NONE)).visualReminder!, /no picture/);
		assert.equal((await run()).visualReminder, undefined, "a call without the field (an old chat) gets no reminder");
		assert.ok(demo.reminder, "the node-id reminder is still there");
	});
});
