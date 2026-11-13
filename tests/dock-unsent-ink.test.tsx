import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import { inkFromStrokes, writeInk } from "../components/sketch/ink-memory.ts";
import type { QuestionAnswerData, SketchPayload, SketchStroke } from "../src/core/index.ts";

// UNSENT INK (owner report, 2026-11-13): a sketch drawn in the sketch view and left there by closing it rides the answer
// the dock sends, "I don't know" included; the chip's remove button sends without it.

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const input = { question: "Which planet is closest to the sun?", options: [{ label: "Venus" }, { label: "Mercury" }], correctAnswer: "Mercury", explanation: "Mercury is the innermost planet." };
const stroke = (n: number): SketchStroke => ({ size: 4, points: [n, n, 0.5, n + 10, n + 10, 0.5] });

let host: HTMLElement;
let root: Root;
let sent: Array<{ answer: QuestionAnswerData; sketch?: SketchPayload }>;

async function mount(toolCallId: string, sketchAvailable = true) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	sent = [];
	await act(async () => root.render(<QuestionDock toolName="quiz" toolCallId={toolCallId} input={input} expanded sketchAvailable={sketchAvailable}
		dictationClaim={false} onExpand={() => {}} onSubmit={(answer, sketch) => { sent.push({ answer, sketch }); }} />));
}
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const el = (testid: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test("I don't know sends the ink waiting on the question's sketch page", async () => {
	writeInk("ink-q1", inkFromStrokes([stroke(1), stroke(2)]));
	await mount("ink-q1");
	assert.ok(el("question-ink-chip"), "the chip says a sketch is attached");
	await act(async () => el("dont-know-button")!.click());
	await settle();
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.answer.dontKnow, true);
	assert.equal(sent[0]!.sketch?.strokes.length, 2, "the work goes with the answer");
	assert.equal(sent[0]!.answer.sketch?.id, sent[0]!.sketch?.id);
});

test("removing the chip sends the answer without the sketch", async () => {
	writeInk("ink-q2", inkFromStrokes([stroke(1)]));
	await mount("ink-q2");
	await act(async () => el("question-ink-chip-remove")!.click());
	assert.equal(el("question-ink-chip"), null);
	await act(async () => el("dont-know-button")!.click());
	await settle();
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.sketch, undefined);
	assert.equal(sent[0]!.answer.sketch, undefined);
});

test("no ink, or no sketch support for the model: nothing is attached and no chip shows", async () => {
	await mount("ink-q3");
	assert.equal(el("question-ink-chip"), null);
	await act(async () => el("dont-know-button")!.click());
	await settle();
	assert.equal(sent[0]!.sketch, undefined);
	await act(async () => root.unmount());
	host.remove();
	writeInk("ink-q4", inkFromStrokes([stroke(1)]));
	await mount("ink-q4", false);
	assert.equal(el("question-ink-chip"), null);
});
