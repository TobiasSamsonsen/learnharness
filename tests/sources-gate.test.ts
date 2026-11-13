/**
 * THE SOURCES GATE (owner, 2026-11-13 — core/sources-gate.ts): in a course Learn session with sources, plan_init waits
 * for a look in them and the first plan says what it found. The pure rule, then the gate live in the teacher agent.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { SOURCES_GATE_REASON_SAY, SOURCES_GATE_REASON_SEARCH, sourcesGateProblem, sourcesGateReason } from "../src/core/sources-gate.ts";

const AVAILABLE = ["plan_init", "material_search", "material_read", "quiz"];
const assistant = (...calls: Array<{ id: string; name: string; args?: unknown }>) =>
	({ role: "assistant", content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ?? {} })) }) as never;
const result = (toolCallId: string, toolName: string, isError = false, details: unknown = null) => ({ role: "toolResult", toolCallId, toolName, isError, details, content: [] }) as never;

describe("sourcesGateProblem (the pure rule)", () => {
	it("only plan_init is gated, and only when the tutor has the search tool", () => {
		assert.equal(sourcesGateProblem([], "quiz", {}, AVAILABLE), null);
		assert.equal(sourcesGateProblem([], "plan_init", {}, ["plan_init", "quiz"]), null, "a session with no sources is never held up");
		assert.equal(sourcesGateProblem([], "plan_init", {}, AVAILABLE), "search");
	});

	it("after a successful lookup the first plan needs its `sources` line", () => {
		const searched = [assistant({ id: "s1", name: "material_search" }), result("s1", "material_search")];
		assert.equal(sourcesGateProblem(searched, "plan_init", {}, AVAILABLE), "say");
		assert.equal(sourcesGateProblem(searched, "plan_init", { sources: "   " }, AVAILABLE), "say");
		assert.equal(sourcesGateProblem(searched, "plan_init", { sources: "Exam 2025 task 2 asks it." }, AVAILABLE), null);
		const read = [assistant({ id: "r1", name: "material_read" }), result("r1", "material_read")];
		assert.equal(sourcesGateProblem(read, "plan_init", { sources: "x" }, AVAILABLE), null, "material_read counts too");
	});

	it("a failed lookup does not count, and a lookup earlier in the same message does", () => {
		const failed = [assistant({ id: "s1", name: "material_search" }), result("s1", "material_search", true)];
		assert.equal(sourcesGateProblem(failed, "plan_init", { sources: "x" }, AVAILABLE), "search");
		const message = assistant({ id: "s2", name: "material_search" }, { id: "p1", name: "plan_init" }) as never;
		assert.equal(sourcesGateProblem([], "plan_init", { sources: "x" }, AVAILABLE, message, "p1"), null);
		assert.equal(sourcesGateProblem([], "plan_init", { sources: "x" }, AVAILABLE, assistant({ id: "p1", name: "plan_init" }, { id: "s2", name: "material_search" }), "p1"), "search", "a lookup written AFTER the call does not count");
	});

	it("a rewrite of the map after a plan went through needs no `sources` again; a plan that failed does not count as one", () => {
		const base = [assistant({ id: "s1", name: "material_search" }), result("s1", "material_search")];
		const planned = [...base, assistant({ id: "p1", name: "plan_init" }), result("p1", "plan_init", false, { ok: true })];
		assert.equal(sourcesGateProblem(planned, "plan_init", {}, AVAILABLE), null);
		const badPlan = [...base, assistant({ id: "p1", name: "plan_init" }), result("p1", "plan_init", false, { ok: false })];
		assert.equal(sourcesGateProblem(badPlan, "plan_init", {}, AVAILABLE), "say");
		const refused = [...base, assistant({ id: "p1", name: "plan_init" }), result("p1", "plan_init", true)];
		assert.equal(sourcesGateProblem(refused, "plan_init", {}, AVAILABLE), "say");
	});

	it("names its reasons", () => {
		assert.equal(sourcesGateReason("search"), SOURCES_GATE_REASON_SEARCH);
		assert.equal(sourcesGateReason("say"), SOURCES_GATE_REASON_SAY);
		assert.match(SOURCES_GATE_REASON_SEARCH, /material_search/);
		assert.match(SOURCES_GATE_REASON_SAY, /`sources`/);
	});
});

describe("the sources gate is live in a course lesson's teacher", () => {
	const planInput = Type.Object({ mermaid: Type.String(), sources: Type.Optional(Type.String()) });
	const planInit: AgentTool<typeof planInput> = {
		name: "plan_init",
		label: "plan_init",
		description: "plan",
		parameters: planInput,
		execute: async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true }) }], details: { ok: true } }),
	};
	const searchInput = Type.Object({ query: Type.String() });
	const materialSearch: AgentTool<typeof searchInput> = {
		name: "material_search",
		label: "material_search",
		description: "search",
		parameters: searchInput,
		execute: async () => ({ content: [{ type: "text", text: "Exam 2025, task 2" }], details: null }),
	};
	const ctx = { chatId: "c", chatStore: { getChat: () => undefined }, jobStore: {}, spawn: () => {} } as never;
	const call = (id: string, name: string, args: unknown) => () => fauxAssistantMessage([fauxToolCall(name, args as ToolCall["arguments"], { id })], { stopReason: "toolUse" });
	const run = async (lesson: boolean, tools: Record<string, AgentTool<any>>, steps: Array<() => ReturnType<typeof fauxAssistantMessage>>) => {
		const faux = createFauxCore({});
		faux.setResponses(steps as never);
		const agent = createTeacherAgent(lesson ? ({ ...(ctx as object), lesson: { skill: { id: "sk_a", name: "A" } } } as never) : undefined, {
			engine: { model: { ...faux.getModel(), provider: "claude-code" }, streamFn: faux.streamSimple },
			tools,
			messages: [{ role: "user", content: "start", timestamp: 1 }] as never,
		});
		await agent.continue();
		return agent.state.messages.filter((m) => (m as { role?: string }).role === "toolResult") as unknown as Array<{ toolCallId: string; isError: boolean; content: Array<{ text: string }> }>;
	};

	it("refuses the plan until the sources were searched and the plan says what they showed", async () => {
		const results = await run(true, { plan_init: planInit, material_search: materialSearch }, [
			call("p1", "plan_init", { mermaid: "graph TD\n a[A]" }),
			call("s1", "material_search", { query: "double root" }),
			call("p2", "plan_init", { mermaid: "graph TD\n a[A]" }),
			call("p3", "plan_init", { mermaid: "graph TD\n a[A]", sources: "Exam 2025 task 2 asks the double root." }),
		]);
		const by = (id: string) => results.find((r) => r.toolCallId === id)!;
		assert.equal(by("p1").isError, true);
		assert.equal(by("p1").content[0]!.text, SOURCES_GATE_REASON_SEARCH);
		assert.equal(by("s1").isError, false);
		assert.equal(by("p2").isError, true);
		assert.equal(by("p2").content[0]!.text, SOURCES_GATE_REASON_SAY);
		assert.equal(by("p3").isError, false, "searched and said: the plan is written");
	});

	it("a session that is not a course lesson, or has no search tool, plans straight away", async () => {
		const noLesson = await run(false, { plan_init: planInit, material_search: materialSearch }, [call("p1", "plan_init", { mermaid: "graph TD\n a[A]" })]);
		assert.equal(noLesson[0]!.isError, false);
		const noSources = await run(true, { plan_init: planInit }, [call("p1", "plan_init", { mermaid: "graph TD\n a[A]" })]);
		assert.equal(noSources[0]!.isError, false);
	});
});
