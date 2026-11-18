/** The researcher's cap salvage (owner, 2026-11-18): a run the 12-request cap cuts off mid-work gets one more request to write
 * its brief, instead of losing everything ("the researcher produced no text"). Scripted offline: no network, no model.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { runResearcherAgent } from "../src/agent/subagents/researcher.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { SearchProvider } from "../src/core/search.ts";

const provider: SearchProvider = { id: "tavily", async search() { return []; } };
const searchStep = (id: string): FauxResponseStep => () =>
	fauxAssistantMessage([fauxToolCall("web_search", { query: "q " + id }, { id })], { stopReason: "toolUse" });
const BRIEF = "## Summary\nBrief written from the salvage request.";
const lastText = (context: { messages: Array<{ role: string; content?: unknown }> }): string =>
	JSON.stringify(context.messages.at(-1)?.content);

function engineWith(steps: FauxResponseStep[]) {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

describe("researcher cap salvage", () => {
	it("a run cut off by the 12-request cap gets one more request and returns its brief", async () => {
		let requests = 0;
		let salvageSeen = false;
		const steps: FauxResponseStep[] = Array.from({ length: 12 }, (_, i) => searchStep("s" + i));
		steps.push((context) => {
			requests++;
			salvageSeen = /request budget is used up/.test(lastText(context));
			return fauxAssistantMessage([fauxText(BRIEF)]);
		});
		const brief = await runResearcherAgent("Anything", { engine: engineWith(steps), search: () => provider });
		assert.equal(brief, BRIEF);
		assert.equal(requests, 1, "exactly one salvage request");
		assert.ok(salvageSeen, "the salvage request ends with the budget message");
	});

	it("a salvage reply that still asks for tools yields no text, not interim narration", async () => {
		const steps: FauxResponseStep[] = Array.from({ length: 12 }, (_, i) => searchStep("s" + i));
		steps.push(() => fauxAssistantMessage([fauxText("Let me search once more."), fauxToolCall("web_search", { query: "again" }, { id: "late" })], { stopReason: "toolUse" }));
		const brief = await runResearcherAgent("Anything", { engine: engineWith(steps), search: () => provider });
		assert.equal(brief, "", "the runner's own no-text failure applies");
	});

	it("a run that finishes before the cap never sends the salvage request", async () => {
		let requests = 0;
		const steps: FauxResponseStep[] = [
			searchStep("s0"),
			(context) => { requests++; assert.ok(!/request budget is used up/.test(lastText(context))); return fauxAssistantMessage([fauxText(BRIEF)]); },
		];
		assert.equal(await runResearcherAgent("Anything", { engine: engineWith(steps), search: () => provider }), BRIEF);
		assert.equal(requests, 1);
	});

	it("the researcher prompt states the request budget", async () => {
		let prompt = "";
		const steps: FauxResponseStep[] = [(context) => {
			const system = context.messages.find((m) => m.role === "system");
			prompt = typeof system?.content === "string" ? system.content : "";
			return fauxAssistantMessage([fauxText(BRIEF)]);
		}];
		await runResearcherAgent("Anything", { engine: engineWith(steps), search: () => provider });
		assert.match(prompt, /at most 12 model requests/);
	});
});

describe("runSubagent salvagePrompt is opt-in", () => {
	const tool = { name: "again", label: "again", description: "Again", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: null }) };
	const cutRun = (extra: Record<string, unknown>) => runSubagent([tool], {
		engine: engineWith([
			() => fauxAssistantMessage([fauxText("Interim note."), fauxToolCall("again", {}, { id: "a1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Salvaged answer.")]),
		]),
		systemPrompt: "Fixture", prompt: "Fixture", maxTurns: 1, ...extra,
	});

	it("without salvagePrompt a cut-off run behaves as before (no extra request)", async () => {
		const result = await cutRun({});
		assert.equal(result.text, "Interim note.");
	});

	it("with salvagePrompt the same cut-off run returns the salvage reply", async () => {
		const result = await cutRun({ salvagePrompt: "Write the answer now." });
		assert.equal(result.text, "Salvaged answer.");
	});
});
