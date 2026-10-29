/**
 * One box per sketch (owner, 2026-10-29): the answer or thinking card shows the image once with the tutor's newest reading
 * beneath it; the standalone read_sketch card steps aside for a sketch an answer or thinking card shows.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: { getItem: () => null, setItem() {} },
});

const { buildSketchReadings } = await import("../components/sketch-readings.ts");
const { ReadSketchCard, SketchReadingBody } = await import("../components/artifacts/read-sketch-card.tsx");
const { AnsweredCard } = await import("../components/answered-card.tsx");
const { ThinkingCard } = await import("../components/practice-cards.tsx");
const { ChatActionsContext } = await import("../components/chat.tsx");
const { buildAnswer, normalizeOptions } = await import("../src/core/index.ts");

/** A real answered ask question carrying a sketch ref. */
function askAnswer(id: string) {
	const qd = { id: "a1", kind: "ask", question: "Draw it", mode: "single-select", options: normalizeOptions([{ label: "A" }, { label: "B" }]), createdAt: new Date().toISOString() };
	return { ...buildAnswer(qd as never, { values: ["A"] }), sketch: ref(id) };
}

const SK = "sk_onebox000000001";
const SK2 = "sk_onebox000000002";
const ref = (id: string) => ({ id, producer: "web-canvas", pages: [{ width: 100, height: 80 }], strokeCount: 3, pointCount: 30 });
const read = (id: string, call: string, reading: string, uncertain: string[] = []) => ({
	type: "tool-read_sketch",
	state: "output-available",
	toolCallId: call,
	input: { sketchId: id, reading, uncertain },
	output: "Reading recorded.",
});
const quiz = (id: string) => ({
	type: "tool-quiz",
	state: "output-available",
	toolCallId: "q1",
	input: {},
	output: { kind: "ask", questionText: "Q?", sketch: ref(id) },
});
const thinking = (id: string) => ({ type: "data-practice-thinking", data: { text: "my words", sketch: ref(id) } });

describe("buildSketchReadings", () => {
	it("gives the reading to the card that shows the sketch, and nowhere else", () => {
		const messages = [{ parts: [quiz(SK)] }, { parts: [read(SK, "r1", "x = 2")] }];
		const r = buildSketchReadings(messages);
		assert.equal(r.shown(SK), true);
		assert.equal(r.shown(SK2), false);
		assert.equal((r.readingFor(0, 0, SK) as { toolCallId: string }).toolCallId, "r1");
		assert.equal(r.readingFor(1, 0, SK), undefined, "the reading's own message is not a card that shows it");
		assert.equal(r.readingFor(0, 0, SK2), undefined);
		assert.equal(r.readingFor(0, 0, undefined), undefined);
	});

	it("shows only the NEWEST reading of a sketch (a re-read after a dispute replaces the first)", () => {
		const messages = [{ parts: [thinking(SK)] }, { parts: [read(SK, "r1", "first")] }, { parts: [read(SK, "r2", "second")] }];
		const r = buildSketchReadings(messages);
		assert.equal((r.readingFor(0, 0, SK) as { toolCallId: string }).toolCallId, "r2");
	});

	it("goes to the FIRST card that shows a sketch (a kept sketch sent again was read once)", () => {
		const messages = [{ parts: [thinking(SK)] }, { parts: [read(SK, "r1", "x")] }, { parts: [thinking(SK)] }];
		const r = buildSketchReadings(messages);
		assert.ok(r.readingFor(0, 0, SK));
		assert.equal(r.readingFor(2, 0, SK), undefined);
	});

	it("ignores an unanswered question and a sketch with no card (a reading nobody shows stays a card of its own)", () => {
		const messages = [{ parts: [{ ...quiz(SK), state: "input-available" }] }, { parts: [read(SK, "r1", "x")] }];
		const r = buildSketchReadings(messages);
		assert.equal(r.shown(SK), false);
	});
});

let host: HTMLElement | undefined;
let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
});
async function render(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(node));
}
const actions = (shown: boolean) => ({
	chatId: "chat_c",
	syncFromServer: async () => {},
	sendText: () => {},
	openSetup: () => {},
	sketchDispute: { state: () => "none" as const, isNewest: () => true, send: () => {} },
	sketchReadings: { shown: () => shown },
});
const count = (sel: string) => document.querySelectorAll(sel).length;

describe("one box", () => {
	it("the answer card shows the image once and the reading under it, in the same box", async () => {
		await render(
			<ChatActionsContext.Provider value={actions(true)}>
				<AnsweredCard answer={askAnswer(SK) as never} chatId="chat_c" reading={read(SK, "r1", "$x^2$") as never} />
			</ChatActionsContext.Provider>,
		);
		assert.equal(count("img"), 1, "one image");
		assert.match(document.body.textContent ?? "", /I read/);
		const reading = document.querySelector('[data-testid="answer-sketch-reading"]')!;
		const image = document.querySelector("img")!;
		assert.ok(reading, "the reading sits in the answer box");
		const order = [...document.querySelectorAll("*")];
		assert.ok(order.indexOf(reading) > order.indexOf(image), "and comes after the image");
		assert.equal(count('[data-testid="read-sketch-card"]'), 0, "no box of its own");
	});

	it("a thinking card does the same", async () => {
		await render(
			<ChatActionsContext.Provider value={actions(true)}>
				<ThinkingCard data={{ text: "my words", sketch: ref(SK) } as never} chatId="chat_c" reading={read(SK, "r1", "y = 3") as never} />
			</ChatActionsContext.Provider>,
		);
		assert.equal(count("img"), 1);
		assert.match(document.body.textContent ?? "", /I read/);
		assert.ok(document.querySelector('[data-testid="answer-sketch-reading"]'));
	});

	it("open doubts get their own red frame inside the box and still ask for the clarification", async () => {
		await render(
			<ChatActionsContext.Provider value={actions(true)}>
				<SketchReadingBody part={read(SK, "r1", "x ? 2", ["the digit after x"]) as never} framed />
			</ChatActionsContext.Provider>,
		);
		const frame = document.querySelector('[data-testid="answer-sketch-reading"]')!;
		assert.equal(frame.getAttribute("data-needs-clarification"), "true");
		assert.ok(document.querySelector('[data-testid="read-sketch-clarify"]'));
		assert.match(document.querySelector('[data-testid="read-sketch-doubts"]')!.textContent ?? "", /Needs your clarification/);
	});

	it("the standalone card renders nothing for a sketch an answer card shows, and everything otherwise", async () => {
		await render(
			<ChatActionsContext.Provider value={actions(true)}>
				<ReadSketchCard part={read(SK, "r1", "z") as never} />
			</ChatActionsContext.Provider>,
		);
		assert.equal(count('[data-testid="read-sketch-card"]'), 0);
		await act(async () => root!.unmount());
		host?.remove();
		await render(
			<ChatActionsContext.Provider value={actions(false)}>
				<ReadSketchCard part={read(SK, "r1", "z") as never} />
			</ChatActionsContext.Provider>,
		);
		assert.equal(count('[data-testid="read-sketch-card"]'), 1);
		assert.match(document.body.textContent ?? "", /I read/);
	});
});
