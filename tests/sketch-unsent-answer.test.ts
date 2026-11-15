/**
 * An answer sent while sketch ink was left off it tells the tutor (owner, 2026-11-15): the compact record carries the flag and the
 * result's `next` says a "drawing failed" message is not an answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnswer, compactAnswerForModel } from "../src/core/question-core.ts";
import { newAnswerResult } from "../src/core/native-messages.ts";
import { SKETCH_UNSENT_NEXT_TEXT, ANSWER_NEXT_TEXT } from "../src/core/prose-gate.ts";

const qd = { kind: "explain", question: "q", options: [], mode: "text", questionType: "final", committedAnswer: "c" } as never;
const text = (r: ReturnType<typeof newAnswerResult>) => JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;

test("the flag survives buildAnswer and reaches the model with its own next text", () => {
	const answer = buildAnswer(qd, { text: "my drawing failed", sketchUnsent: true }, "explain");
	assert.equal(answer.sketchUnsent, true);
	assert.equal(compactAnswerForModel(answer).sketchUnsent, true);
	const result = text(newAnswerResult("t1", "explain", answer));
	assert.equal(result.next, SKETCH_UNSENT_NEXT_TEXT);
	assert.match(String(result.next), /skipped/);
});

test("an ordinary text answer is unchanged", () => {
	const answer = buildAnswer(qd, { text: "diagonalizable" }, "explain");
	assert.equal(answer.sketchUnsent, undefined);
	assert.equal(text(newAnswerResult("t2", "explain", answer)).next, ANSWER_NEXT_TEXT);
});
