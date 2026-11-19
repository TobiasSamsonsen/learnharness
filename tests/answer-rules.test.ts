/**
 * The shared tutor wording (owner, 2026-11-18, the Taylor lesson): a step asked again is the SAME size, an equivalent
 * notation is never an error, hints are short, and the refusals say exactly what to resend.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FRESH_CASE, HINT_NOTATION_RULE, NOTATION_RULE } from "../src/core/answer-rules.ts";
import { hintPrompt, hintsNextText, practiceHintPrompt } from "../src/core/hints.ts";
import { LEAD_FLOOR_REASON } from "../src/core/lead-floor-gate.ts";
import { paceSection } from "../src/core/pace.ts";
import { ANSWER_NEXT_TEXT, SKETCH_ANSWER_NEXT_TEXT } from "../src/core/prose-gate.ts";
import { MISSING_QUESTION_MESSAGE } from "../src/core/question-core.ts";
import { verdictGateReason } from "../src/core/verdict-gate.ts";

describe("a right answer after hints moves on (owner, 2026-11-19)", () => {
	it("the hinted-answer text asks for no recheck and no mention of the system", () => {
		const text = hintsNextText(1);
		assert.match(text, /If the answer was right, go on/);
		assert.ok(!text.includes(FRESH_CASE) && !/once more/.test(text));
	});
});

describe("a step asked again is the same size", () => {
	it("every place that says \"fresh case\" now says what size", () => {
		assert.match(FRESH_CASE, /SAME size/);
		for (const text of [
			ANSWER_NEXT_TEXT,
			SKETCH_ANSWER_NEXT_TEXT,
			verdictGateReason({ kind: "contradiction" } as never),
		]) {
			assert.ok(text.includes(FRESH_CASE), text.slice(0, 80));
		}
		for (const pace of ["crash", "efficient"] as const) {
			const text = paceSection("teacher", pace, undefined);
			assert.ok(!/hinted answer is the exception/.test(text), pace);
			if (pace === "crash") assert.match(text, /right answer after hints still moves on/);
		}
	});
});

describe("an equivalent notation is never an error", () => {
	it("the answer results and both hint prompts say so", () => {
		assert.ok(ANSWER_NEXT_TEXT.includes(NOTATION_RULE));
		assert.ok(SKETCH_ANSWER_NEXT_TEXT.includes(NOTATION_RULE));
		assert.ok(hintPrompt({ n: 1, earlier: [] }).includes(HINT_NOTATION_RULE));
		assert.ok(practiceHintPrompt({ n: 1, earlier: [] }).includes(HINT_NOTATION_RULE));
	});
});

describe("hints are short", () => {
	it("both prompts cap a hint at 40 words and one idea", () => {
		assert.match(hintPrompt({ n: 1, earlier: [] }), /At most 40 words, one idea\./);
		assert.match(practiceHintPrompt({ n: 1, earlier: [] }), /At most 40 words, one idea\./);
	});
});

describe("the refusals say what to resend", () => {
	it("a repair written in thinking is told to be written again in the lead", () => {
		assert.match(LEAD_FLOOR_REASON, /what you wrote in your thinking never reaches him/);
	});
	it("a call with no question is told about real line breaks and single backslashes", () => {
		assert.match(MISSING_QUESTION_MESSAGE, /real line breaks/);
		assert.match(MISSING_QUESTION_MESSAGE, /single backslashes/);
	});
});
