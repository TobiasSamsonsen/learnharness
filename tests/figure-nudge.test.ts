/**
 * A broken figure in a plain-text reply gets one hidden reminder (owner, 2026-11-25 — the Superposisjon lesson: a resistor and a
 * current source drawn on top of each other). The pure rule; the question tools' own gate is figureInputProblems.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFauxCore, fauxAssistantMessage, fauxText, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { bareQuestionTools, createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { figureNudgeText, textFigureProblems } from "../src/core/figure-nudge.ts";

const message = (text: string, stopReason: AssistantMessage["stopReason"] = "stop", extra: AssistantMessage["content"] = []): AssistantMessage => ({
	role: "assistant", content: [{ type: "text", text }, ...extra], api: "faux", provider: "faux", model: "faux",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason, timestamp: 1,
});
const fence = (src: string) => "Look:\n\n```circuit id=c1\n" + src + "\n```\n\nDone.";
const stacked = "V1 a1 0 12V; down\nR1 a1 a 1k; right\nR2 a 0 2k; down\nI1 a 0 3mA; down\nnodes a";
const fixed = "V1 a1 0 12V; down\nR1 a1 a 1k; right\nR2 a 0 2k; down\nW a b; right\nI1 b 0 3mA; down\nnodes a";

describe("textFigureProblems", () => {
	it("names a figure whose parts sit on top of each other", () => {
		const problems = textFigureProblems(message(fence(stacked)));
		assert.equal(problems.length, 1);
		assert.match(problems[0]!, /R2 and I1 are drawn on top of each other/);
	});

	it("is empty for a good figure, for text without a figure, and for a turn that is not a text-only stop", () => {
		assert.deepEqual(textFigureProblems(message(fence(fixed))), []);
		assert.deepEqual(textFigureProblems(message("No figure here, only `code`.")), []);
		assert.deepEqual(textFigureProblems(message(fence(stacked), "toolUse")), []);
		assert.deepEqual(textFigureProblems(message(fence(stacked), "stop", [{ type: "toolCall", id: "t1", name: "quiz", arguments: {} }])), []);
	});
});

describe("figureNudgeText", () => {
	it("lists the problems and says it is not from the learner", () => {
		const text = figureNudgeText(["figure 1 line 4: R2 and I1 are drawn on top of each other"]);
		assert.match(text, /NOT FROM THE LEARNER/);
		assert.match(text, /- figure 1 line 4: R2 and I1/);
	});
});

describe("the reminder is live in the teacher: once per run, hidden", () => {
	function run(responses: Array<() => AssistantMessage>) {
		const faux = createFauxCore({});
		faux.setResponses(responses);
		const requests: string[] = [];
		const agent = createTeacherAgent(undefined, {
			engine: {
				model: faux.getModel(),
				streamFn: (m, context, options) => {
					requests.push(JSON.stringify(context.messages.at(-1)));
					assert.ok(getCurrentTools(context.messages).some((t) => t.name === "quiz"));
					return faux.streamSimple(m, context, options);
				},
			},
			tools: bareQuestionTools(),
			messages: [{ role: "user", content: "show me the circuit", timestamp: 0 }] as never,
		});
		return { agent, requests };
	}

	it("a text-only reply with a broken figure gets the problems back once, and the redraw goes through", async () => {
		const { agent, requests } = run([
			() => fauxAssistantMessage([fauxText(fence(stacked))], { stopReason: "stop" }),
			() => fauxAssistantMessage([fauxText(fence(fixed))], { stopReason: "stop" }),
			() => fauxAssistantMessage([fauxText("Must never be asked for.")], { stopReason: "stop" }),
		]);
		await agent.continue();
		assert.equal(requests.length, 2, "the run continued at its own stop, then ended on the good figure");
		assert.ok(requests[1]!.includes("drawn on top of each other"), "the second request ends with the problem");
		const marker = agent.state.messages.find((m) => (m as { customType?: string }).customType === "check-nudge") as { content: string; display: boolean } | undefined;
		assert.ok(marker && marker.display === false, "kept in the record as a hidden marker");
	});

	it("a still-broken redraw does not loop: one reminder per run", async () => {
		const { agent, requests } = run([
			() => fauxAssistantMessage([fauxText(fence(stacked))], { stopReason: "stop" }),
			() => fauxAssistantMessage([fauxText(fence(stacked))], { stopReason: "stop" }),
			() => fauxAssistantMessage([fauxText("Must never be asked for.")], { stopReason: "stop" }),
		]);
		await agent.continue();
		assert.equal(requests.length, 2);
	});

	it("a good figure is left alone", async () => {
		const { agent, requests } = run([() => fauxAssistantMessage([fauxText(fence(fixed))], { stopReason: "stop" })]);
		await agent.continue();
		assert.equal(requests.length, 1);
	});
});
