import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import type { QuestionAnswerData } from "../src/core/index.ts";

// THE STEER BUTTON (owner, 2026-11-18): write to the tutor instead of answering. The open question is set aside (a dismissal that
// carries his words and wakes the tutor), on lesson checks only.

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const input = { question: "Which planet is closest to the sun?", options: [{ label: "Venus" }, { label: "Mercury" }], correctAnswer: "Mercury", explanation: "Mercury is the innermost planet." };

let host: HTMLElement;
let root: Root;
let sent: QuestionAnswerData[];

async function mount(phase: "probe" | "teach", toolName: "quiz" | "ask_user_question" = "quiz") {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	sent = [];
	await act(async () => root.render(<QuestionDock toolName={toolName} toolCallId={`steer-${phase}`} input={input} expanded phase={phase}
		dictationClaim={false} onExpand={() => {}} onSubmit={(answer) => { sent.push(answer); }} />));
}
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const el = <T extends HTMLElement = HTMLButtonElement>(testid: string) => host.querySelector<T>(`[data-testid="${testid}"]`);
// linkedom does not carry a textarea's input event into React's onChange, so the change handler is called as React would call it
const type = (node: HTMLTextAreaElement, value: string) => act(async () => {
	const propsKey = Object.keys(node).find((k) => k.startsWith("__reactProps$"))!;
	(node as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!.onChange({ target: { value } });
});
const click = (testid: string) => act(async () => el(testid)!.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));

test("a lesson check offers it; a probe question does not", async () => {
	await mount("teach");
	assert.ok(el("question-steer"), "the button is there in the teach phase");
	await act(async () => root.unmount());
	host.remove();
	await mount("probe");
	assert.equal(el("question-steer"), null);
});

test("the button opens the box; sending sets the question aside with his words, nothing graded", async () => {
	await mount("teach");
	assert.equal(el("question-steer-box"), null);
	await click("question-steer");
	assert.ok(el("question-steer-box"));
	assert.equal(el("question-steer-send")!.disabled, true, "nothing to send yet");
	await type(el<HTMLTextAreaElement>("question-steer-input")!, "  Please use my lecture's notation.  ");
	assert.equal(el("question-steer-send")!.disabled, false);
	await click("question-steer-send");
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.dismissed, true, "a dismissal: no grade, no mastery");
	assert.equal(sent[0]!.steer, "Please use my lecture's notation.");
	assert.equal(sent[0]!.correct, undefined);
	assert.equal(sent[0]!.kind, "quiz");
	assert.equal(el("question-steer-box"), null, "the box closes");
});

test("cancel closes the box and sends nothing", async () => {
	await mount("teach");
	await click("question-steer");
	await type(el<HTMLTextAreaElement>("question-steer-input")!, "never mind");
	await click("question-steer-cancel");
	assert.equal(el("question-steer-box"), null);
	assert.equal(sent.length, 0);
});
