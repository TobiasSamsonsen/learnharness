/**
 * THE QUESTION CARRIES ITS OWN INSTANCE (owner, 2026-11-14): the data a question is about (a matrix, a function, numbers)
 * is written in `question` or `details`, never only in `lead`, because the sketch view's problem pill shows only those.
 * The rule is in the tool field descriptions and in the teaching prompts; after a miss a fresh instance follows.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { explainInputObject, quizInputObject } from "../src/core/question-core.ts";

const description = (schema: { properties: object }, field: string): string => (schema.properties as Record<string, { description?: string }>)[field]?.description ?? "";
const prompt = (...parts: string[]): string => fs.readFileSync(path.resolve("src/agent/prompts", ...parts), "utf8");

describe("the instance lives in the question", () => {
	it("the question and lead fields of both teach tools say so", () => {
		for (const schema of [quizInputObject, explainInputObject] as const) {
			assert.match(description(schema, "question"), /INSTANCE he works on.*in full HERE or in `details`, never only in `lead`/);
			assert.match(description(schema, "question"), /sketch view shows only this question and `details`/);
			assert.match(description(schema, "lead"), /never states\s+the question's own instance and never carries out its steps/);
		}
	});

	it("the teaching prompts carry the rule and the fresh-instance rule", () => {
		const principles = prompt("teacher", "30-question-principles.md");
		assert.match(principles, /The question carries its own instance, and the lead never works it/);
		assert.match(principles, /the sketch view shows only those two/);
		assert.match(principles, /After a miss on a calculation, a fresh instance/);
		assert.match(prompt("shared", "20-question-tools.md"), /The instance lives in the question/);
	});
});
