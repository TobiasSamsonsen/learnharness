import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";

const QUIZ = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
} as never;

const dock = (wordingOnly: boolean) =>
	renderToStaticMarkup(
		<QuestionDock toolName="quiz" toolCallId="call-1" messageId="m1" wordingOnly={wordingOnly} input={QUIZ} expanded onExpand={() => {}} onSubmit={() => {}} />,
	);

/** The opening tag of the element carrying this data-testid / role, to read its class list. */
function tagOf(html: string, marker: string): string {
	const at = html.indexOf(marker);
	assert.ok(at >= 0, `found ${marker}`);
	return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
}

describe("QuestionDock — wordingOnly (a follow-up card about the wording is open)", () => {
	it("by default the options, the confidence row and the answer form are all shown", () => {
		const html = dock(false);
		for (const marker of ['role="radiogroup"', 'data-testid="confidence-row"', "<form"]) {
			assert.equal(/\bhidden\b/.test(tagOf(html, marker)), false, `${marker} is shown`);
		}
	});

	it("wordingOnly hides them but keeps them mounted (a half-made selection and typed text survive)", () => {
		const html = dock(true);
		for (const marker of ['role="radiogroup"', 'data-testid="confidence-row"', "<form"]) {
			assert.ok(/\bhidden\b/.test(tagOf(html, marker)), `${marker} is hidden, not removed`);
		}
		assert.ok(html.includes("Which planet is closest to the sun?"), "the wording still shows");
		assert.ok(html.includes("Mercury"), "the options are still in the DOM");
	});

	it("the wording stays a markable passage of its message and call in both states", () => {
		for (const html of [dock(false), dock(true)]) {
			assert.match(html, /data-source-message-id="m1"/);
			assert.match(html, /data-source-call-id="call-1"/);
		}
	});
});

describe("PracticeDock — wordingOnly", () => {
	const practice = (wordingOnly: boolean) =>
		renderToStaticMarkup(
			<PracticeDock problemCallId="prob-1" messageId="m2" wordingOnly={wordingOnly} input={{ statement: "Find the root of x^2 = 9." }} expanded onExpand={() => {}}
				onSubmit={async () => true} chatId="chat_x" />,
		);

	it("hides the learner's half, keeps the statement and its passage markers", () => {
		const html = practice(true);
		assert.ok(/\bhidden\b/.test(tagOf(html, 'data-testid="practice-thinking-field"')));
		assert.ok(html.includes("Find the root of x^2 = 9."));
		assert.match(html, /data-source-call-id="prob-1"/);
		assert.equal(/\bhidden\b/.test(tagOf(practice(false), 'data-testid="practice-thinking-field"')), false);
	});
});
