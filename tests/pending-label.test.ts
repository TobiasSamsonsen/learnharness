import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isWritingText, pendingLabel, probeHandoffOwed, type LiveMessage } from "../components/pending-label.ts";

const asst = (...parts: Array<{ type: string; state?: string; output?: unknown }>): LiveMessage => ({ role: "assistant", parts });

describe("pendingLabel", () => {
	it("names the tool that is running at the tail", () => {
		assert.equal(pendingLabel([asst({ type: "tool-material_search", state: "input-available" })]), "Searching materials");
		assert.equal(pendingLabel([asst({ type: "tool-material_read", state: "input-available" })]), "Reading materials");
		assert.equal(pendingLabel([asst({ type: "tool-plan_init", state: "input-streaming" })]), "Planning");
		assert.equal(pendingLabel([asst({ type: "tool-quiz", state: "input-streaming" })]), "Writing a question");
		assert.equal(pendingLabel([asst({ type: "tool-probe_done", state: "input-available" })]), "Assessing");
	});

	it("says Thinking once the tool returned, for an unknown tool, and with no assistant tail", () => {
		assert.equal(pendingLabel([asst({ type: "tool-material_search", state: "output-available" })]), "Thinking");
		assert.equal(pendingLabel([asst({ type: "tool-brand_new_tool", state: "input-available" })]), "Thinking");
		assert.equal(pendingLabel([asst({ type: "reasoning" })]), "Thinking");
		assert.equal(pendingLabel([{ role: "user", parts: [{ type: "text" }] }]), "Thinking");
		assert.equal(pendingLabel([]), "Thinking");
	});
});

describe("isWritingText", () => {
	const textPart = (text: string) => ({ type: "text", text }) as LiveMessage["parts"][number];

	it("is true while the newest part is non-empty text", () => {
		assert.equal(isWritingText([asst({ type: "reasoning" }, textPart("Her er planen"))]), true);
	});

	it("is false once a tool call or reasoning follows the text, or the text is empty", () => {
		assert.equal(isWritingText([asst(textPart("Hei"), { type: "tool-material_search", state: "input-available" })]), false);
		assert.equal(isWritingText([asst(textPart("Hei"), { type: "reasoning" })]), false);
		assert.equal(isWritingText([asst(textPart("  "))]), false);
	});

	it("is false when the newest message is not an assistant one or is empty", () => {
		assert.equal(isWritingText([{ role: "user", parts: [textPart("hei")] }]), false);
		assert.equal(isWritingText([]), false);
		assert.equal(isWritingText([asst()]), false);
	});
});

describe("probeHandoffOwed", () => {
	const done = { type: "tool-probe_done", state: "output-available", output: { ok: true } };

	it("is owed when the transcript ends on a clean probe_done", () => {
		assert.equal(probeHandoffOwed([asst({ type: "text" }, done)]), true);
	});

	it("tolerates trailing reasoning, text and step parts", () => {
		assert.equal(probeHandoffOwed([asst(done, { type: "step-start" }, { type: "reasoning" }, { type: "text" })]), true);
	});

	it("is not owed once planning started (a later tool call or plan block)", () => {
		assert.equal(probeHandoffOwed([asst(done, { type: "step-start" }, { type: "tool-material_search", state: "output-available" })]), false);
		assert.equal(probeHandoffOwed([asst(done, { type: "data-plan-block" })]), false);
	});

	it("is not owed for a refused or unfinished probe_done", () => {
		assert.equal(probeHandoffOwed([asst({ ...done, output: { ok: false } })]), false);
		assert.equal(probeHandoffOwed([asst({ type: "tool-probe_done", state: "input-available" })]), false);
		assert.equal(probeHandoffOwed([asst({ type: "tool-probe_done", state: "output-error" })]), false);
	});

	it("is not owed when the last message is not an assistant one or has no probe_done", () => {
		assert.equal(probeHandoffOwed([]), false);
		assert.equal(probeHandoffOwed([asst(done), { role: "user", parts: [{ type: "text" }] }]), false);
		assert.equal(probeHandoffOwed([asst({ type: "text" })]), false);
	});
});
