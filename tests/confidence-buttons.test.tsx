import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import type { QuestionAnswerData } from "../src/core/index.ts";

// The Anki-style confidence buttons (owner, 2026-10-28): pick an answer, press how sure you are, and the press submits.

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const input = { question: "Which planet is closest to the sun?", options: [{ label: "Venus" }, { label: "Mercury" }], correctAnswer: "Mercury", explanation: "Mercury is the innermost planet." };

let host: HTMLElement;
let root: Root;
let answers: QuestionAnswerData[];

beforeEach(async () => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	answers = [];
	await act(async () => root.render(<QuestionDock toolName="quiz" toolCallId="q1" input={input} expanded
		dictationClaim={false} onExpand={() => {}} onSubmit={(a) => { answers.push(a); }} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const button = (testid: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!;
const pick = async (label: string) => {
	const choice = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent?.includes(label))!;
	await act(async () => choice.click());
};
const press = async (key: string) => act(async () => { document.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true }), { key })); });

test("the five levels wait for an answer, then a press submits it with that confidence", async () => {
	for (const stop of [30, 50, 70, 90, 100]) assert.equal(button(`confidence-btn-${stop}`).disabled, true, `${stop} before a pick`);
	await pick("Mercury");
	for (const stop of [30, 50, 70, 90, 100]) assert.equal(button(`confidence-btn-${stop}`).disabled, false, `${stop} after a pick`);
	await act(async () => button("confidence-btn-70").click());
	assert.equal(answers.length, 1);
	assert.equal(answers[0]!.confidence, 70);
	assert.equal(answers[0]!.correct, true);
	assert.equal(answers[0]!.answers[0]!.value, "Mercury");
});

test("I don't know submits at once with no answer and no confidence", async () => {
	assert.equal(button("dont-know-button").disabled, false);
	await act(async () => button("dont-know-button").click());
	assert.equal(answers.length, 1);
	assert.equal(answers[0]!.dontKnow, true);
	assert.equal(answers[0]!.confidence, undefined);
	assert.equal(answers[0]!.answers.length, 0);
});

test("number keys press the levels (1-5) and I don't know (0); a level key waits for a pick", async () => {
	await press("3");
	assert.equal(answers.length, 0, "no answer picked yet");
	await pick("Venus");
	await press("4");
	assert.equal(answers.length, 1);
	assert.equal(answers[0]!.confidence, 90);
	assert.equal(answers[0]!.correct, false);
});

test("0 presses I don't know even before a pick", async () => {
	await press("0");
	assert.equal(answers.length, 1);
	assert.equal(answers[0]!.dontKnow, true);
});

test("arrows move the highlight over the five levels and Enter presses it", async () => {
	await pick("Mercury");
	await press("ArrowRight");
	assert.equal(button("confidence-btn-50").getAttribute("data-highlighted"), "", "from unset a first arrow lands on 50");
	await press("ArrowRight");
	await press("ArrowRight");
	await press("ArrowRight");
	await press("ArrowRight");
	assert.equal(button("confidence-btn-100").getAttribute("data-highlighted"), "", "clamped at Certain");
	await press("ArrowLeft");
	assert.equal(button("confidence-btn-90").getAttribute("data-highlighted"), "");
});
