import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { isSubagentSteer, newestLearnerTurnFrom, partKeys, partShows, stepSeparators, type RowPart } from "../components/transcript-rows.ts";
import { newGraphContextMessage, newUserMessage, type LhMarkerMessage } from "../src/core/native-messages.ts";
import { projectView, type LhViewMessage } from "../src/core/view.ts";

const step: RowPart = { type: "step-start" };
const text = (t: string): RowPart => ({ type: "text", text: t });
const tool = (name: string, state = "output-available"): RowPart => ({ type: `tool-${name}`, state });

describe("partShows", () => {
	it("hides reasoning, step markers, empty text and activity tools", () => {
		assert.equal(partShows({ type: "reasoning", text: "hmm" }), false);
		assert.equal(partShows(step), false);
		assert.equal(partShows(text("  ")), false);
		for (const name of ["material_search", "material_read", "read", "ls", "grep", "list_sessions", "plan_init", "brand_new_tool"]) {
			assert.equal(partShows(tool(name)), false, name);
		}
	});

	it("shows text, the plan block and the content cards", () => {
		assert.equal(partShows(text("Hei")), true);
		assert.equal(partShows({ type: "data-plan-block" }), true);
		for (const name of ["probe_done", "visual", "demo", "show_figure", "problem", "conclude", "research", "read_sketch"]) {
			assert.equal(partShows(tool(name)), true, name);
		}
	});

	it("shows a question only once answered, and finish only once it went through", () => {
		assert.equal(partShows(tool("quiz", "input-streaming")), false);
		assert.equal(partShows(tool("quiz", "output-available")), true);
		assert.equal(partShows(tool("finish_lesson", "input-available")), false);
		assert.equal(partShows(tool("finish_lesson", "output-available")), true);
	});

	it("shows plugin question and problem parts", () => {
		assert.equal(partShows({ type: "tool-quiz", pluginQuestion: {} }), true);
		assert.equal(partShows({ type: "tool-problem", pluginProblem: {} }), true);
	});
});

describe("partKeys", () => {
	it("keeps a text part's key when a part of another type is inserted before it", () => {
		const before = partKeys([step, tool("plan_init"), text("plan"), text("closing")]);
		const after = partKeys([step, tool("plan_init"), { type: "data-plan-block", id: "pb_1" } as RowPart, text("plan"), text("closing")]);
		assert.equal(before[2], after[3], "the plan text keeps its key when the plan block is spliced in before it");
		assert.equal(before[3], after[4]);
	});

	it("keys tool parts by call id and data parts by id", () => {
		const keys = partKeys([{ type: "tool-quiz", toolCallId: "call-7" } as RowPart, { type: "data-plan-block", id: "pb_1" } as RowPart]);
		assert.deepEqual(keys, ["c:call-7", "d:pb_1"]);
	});

	it("counts per type and never repeats a key", () => {
		const keys = partKeys([text("a"), text("b"), { type: "tool-x", toolCallId: "same" } as RowPart, { type: "tool-x", toolCallId: "same" } as RowPart]);
		assert.deepEqual(keys.slice(0, 2), ["text#0", "text#1"]);
		assert.equal(new Set(keys).size, 4);
	});
});

describe("stepSeparators", () => {
	it("draws a hairline only between steps that both show something", () => {
		const parts = [step, text("a"), step, tool("material_search"), step, { type: "reasoning" }, step, text("b")];
		// idx: 0 step, 1 text, 2 step, 3 tool(hidden), 4 step, 5 reasoning(hidden), 6 step, 7 text
		assert.deepEqual([...stepSeparators(parts)], [6]);
	});

	it("draws none above the first visible step", () => {
		assert.deepEqual([...stepSeparators([step, { type: "reasoning" }, step, text("a")])], []);
	});

	it("counts content before the first step marker", () => {
		assert.deepEqual([...stepSeparators([text("a"), step, text("b")])], [1]);
	});

	it("draws none for a message of only hidden rows", () => {
		assert.deepEqual([...stepSeparators([step, tool("grep"), step, { type: "reasoning" }])], []);
	});
});

const learner = newUserMessage("Explain this step.");
const answer: LhViewMessage = { id: "answer", role: "assistant", parts: [{ type: "text", text: "Here is the next step." }] };
const context = newGraphContextMessage([], []);

for (const customType of ["subagent-steer", "subagent-abort"] as const) {
	test(`projected ${customType} does not end the newest learner turn`, () => {
		const marker: LhMarkerMessage = {
			id: customType, role: "custom", customType, display: true, content: "Background update for the teacher.",
			details: { kind: "research", ...(customType === "subagent-abort" ? { aborted: true } : {}) }, timestamp: 0,
		};
		const [projected] = projectView([marker]);
		assert.ok(projected);
		assert.equal(projected.role, "user");
		assert.ok(projected.parts.some((part) => part.type === "text"));
		assert.ok(isSubagentSteer(projected));
		const historical = projectView([newUserMessage("Earlier question."), learner]);
		assert.equal(historical[1]?.id, learner.id);
		assert.equal(newestLearnerTurnFrom([...historical, answer, projected]), 1);
		assert.equal(newestLearnerTurnFrom([projected]), -1);
	});
}

test("learner text and image-only rows start turns; projected data-only rows do not", () => {
	const photo = newUserMessage("", [{ type: "image", mimeType: "image/png", data: "AA==" }]);
	const rows = projectView([learner, photo, context]);
	assert.equal(rows[0]?.id, learner.id);
	assert.equal(rows[1]?.id, photo.id);
	assert.deepEqual(rows[1]?.parts.map((part) => part.type), ["image"]);
	assert.deepEqual(rows[2]?.parts.map((part) => part.type), ["data-graph-context"]);
	assert.equal(newestLearnerTurnFrom(rows.slice(0, 1)), 0);
	assert.equal(newestLearnerTurnFrom(rows), 1);
	assert.equal(newestLearnerTurnFrom([answer, ...projectView([context])]), -1);
});
