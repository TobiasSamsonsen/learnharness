/**
 * Retries in the transcript (owner, 2026-10-27): hidden once the lesson has
 * moved on; one quiet line while a run of retries is the newest thing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retryPlan, withoutRetries, type StepPart } from "../components/retry-steps.ts";

const step: StepPart = { type: "step-start" };
const thinking: StepPart = { type: "reasoning", text: "drafting the reply" };
const refused: StepPart = { type: "tool-quiz", state: "output-error", errorText: "Refused: …" };
const posed: StepPart = { type: "tool-quiz", state: "output-available" };
const prose: StepPart = { type: "text", text: "Not quite — …" };

describe("retryPlan", () => {
	it("a message with no retries hides nothing and has no line", () => {
		const plan = retryPlan([step, prose, posed]);
		assert.equal(plan.hidden.size, 0);
		assert.equal(plan.lineAt, null);
	});

	it("retries followed by real content disappear completely (no line)", () => {
		// 0 step, 1 thinking, 2 refused | 3 step, 4 thinking, 5 refused | 6 step, 7 text, 8 quiz
		const plan = retryPlan([step, thinking, refused, step, thinking, refused, step, prose, posed]);
		assert.deepEqual([...plan.hidden].sort(), [0, 1, 2, 3, 4, 5]);
		assert.equal(plan.lineAt, null);
	});

	it("while the retries are the newest thing, ONE line stands in the place of the run", () => {
		const plan = retryPlan([step, prose, step, thinking, refused, step, thinking, refused]);
		assert.equal(plan.lineAt, 2, "at the first retry step of the run");
		assert.deepEqual([...plan.hidden].sort(), [2, 3, 4, 5, 6, 7]);
	});

	it("a failed call is not a retry when its step wrote text, or when it was aborted", () => {
		assert.equal(retryPlan([step, prose, refused]).hidden.size, 0);
		const aborted: StepPart = { type: "tool-quiz", state: "output-error", errorText: "Operation aborted" };
		assert.equal(retryPlan([step, thinking, aborted]).hidden.size, 0);
	});

	it("a step with one failed and one good call is not a retry", () => {
		assert.equal(retryPlan([step, refused, posed]).hidden.size, 0);
	});

	it("a first step without a step-start part is still a step", () => {
		const plan = retryPlan([thinking, refused, step, prose]);
		assert.deepEqual([...plan.hidden].sort(), [0, 1]);
		assert.equal(plan.lineAt, null);
	});
});

describe("retryPlan while the next step is still being written", () => {
	it("the step after a run of retries stays hidden until it says or poses something, so the line does not flicker", () => {
		const plan = retryPlan([step, prose, step, thinking, refused, step, thinking]);
		assert.equal(plan.lineAt, 2, "the line stays where it was");
		assert.deepEqual([...plan.hidden].sort(), [2, 3, 4, 5, 6]);
		const streaming: StepPart = { type: "tool-quiz", state: "input-streaming" };
		assert.equal(retryPlan([step, prose, step, thinking, refused, step, thinking, streaming]).lineAt, 2);
	});

	it("it shows as soon as it has text or a posed question", () => {
		for (const real of [prose, posed]) {
			const plan = retryPlan([step, prose, step, thinking, refused, step, thinking, real]);
			assert.equal(plan.lineAt, null);
			assert.deepEqual([...plan.hidden].sort(), [2, 3, 4]);
		}
	});

	it("a lone thinking step with no retry before it is just thinking", () => {
		assert.equal(retryPlan([step, prose, step, thinking]).hidden.size, 0);
	});
});

describe("retryPlan's first visible part (no stray separator above it)", () => {
	it("is 0 when nothing before it is hidden", () => {
		assert.equal(retryPlan([step, prose]).first, 0);
	});

	it("skips the retry steps that open a message", () => {
		// 0 step, 1 thinking, 2 refused | 3 step, 4 text
		assert.equal(retryPlan([step, thinking, refused, step, prose]).first, 3);
	});

	it("is the line when the whole message is retries", () => {
		assert.equal(retryPlan([step, thinking, refused]).first, 0);
	});
});

describe("withoutRetries", () => {
	it("blanks the hidden parts and keeps every index", () => {
		const parts = [step, thinking, refused, step, prose];
		const out = withoutRetries(parts, retryPlan(parts));
		assert.deepEqual(out.map((p) => p.type), ["retry", "retry", "retry", "step-start", "text"]);
	});
});
