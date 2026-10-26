/**
 * Sketch answers — the pure contract (Android plan M1, 2026-10-26):
 * payload validation, the render plan (crop, scale, bands), the record's
 * ref, the model projection (images at the boundary, stubs when a page is
 * missing), the input events, the answer record, and compaction's view.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	ChatInputError,
	SKETCH_MAX_EDGE,
	SKETCH_MAX_PAGES,
	SKETCH_MAX_REQUEST_PAGES,
	SketchPayloadError,
	estimateSketchRequestTokens,
	requestSketchPages,
	sketchPageTokens,
	compactAnswerForModel,
	dockSubmitGate,
	estimateMessageTokens,
	inputAppends,
	isSketchRef,
	newAnswerResult,
	newSketchId,
	newThinkingMessage,
	parseChatInput,
	parseSketchPayload,
	planSketch,
	serializeForSummary,
	sketchLabel,
	sketchOfMessage,
	sketchStrokeHit,
	keptSketchOf,
	sketchRefOf,
	toLlmMessages,
	type LhMessage,
	type QuestionAnswerData,
	type SketchPayload,
	type SketchStroke,
} from "../src/core/index.ts";

/** A straight stroke from (x0, y0) to (x1, y1), `n` samples. */
function line(x0: number, y0: number, x1: number, y1: number, n = 12, size = 4): SketchStroke {
	const points: number[] = [];
	for (let i = 0; i < n; i++) {
		const t = i / (n - 1);
		points.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 0.5);
	}
	return { size, points };
}

const ID = "sk_abcdefgh12345678";
const payload = (strokes: SketchStroke[], id = ID): SketchPayload => ({ id, producer: "web-canvas", strokes });

describe("parseSketchPayload", () => {
	it("accepts a valid payload and returns a clean copy", () => {
		const raw = { ...payload([line(10, 10, 200, 40)]), extra: "dropped" };
		const parsed = parseSketchPayload(raw);
		assert.deepEqual(Object.keys(parsed).sort(), ["id", "producer", "strokes"]);
		assert.equal(parsed.strokes.length, 1);
	});

	it("refuses broken payloads with SketchPayloadError", () => {
		const bad: unknown[] = [
			null,
			{ ...payload([line(0, 0, 10, 10)]), id: "nope" },
			{ ...payload([line(0, 0, 10, 10)]), producer: "pencil" },
			payload([]),
			payload([{ size: 4, points: [1, 2] }]),
			payload([{ size: 4, points: [1, 2, 1.5] }]), // pressure > 1
			payload([{ size: 0, points: [1, 2, 0.5] }]),
			payload([{ size: 4, color: "red", points: [1, 2, 0.5] }]),
			payload([{ size: 4, points: [Number.NaN, 2, 0.5] }]),
		];
		for (const value of bad) assert.throws(() => parseSketchPayload(value), SketchPayloadError, JSON.stringify(value));
	});

	it("refuses more than the stroke limit", () => {
		const many = Array.from({ length: 3001 }, (_, i) => line(i, 0, i, 1, 2));
		assert.throws(() => parseSketchPayload(payload(many)), /more than 3000 strokes/);
	});

	it("mints ids the validator accepts", () => {
		assert.doesNotThrow(() => parseSketchPayload(payload([line(0, 0, 40, 40)], newSketchId())));
	});
});

describe("planSketch", () => {
	it("crops to the ink and keeps one page within the edge cap", () => {
		const plan = planSketch(payload([line(1000, 1000, 1600, 1300)]));
		assert.equal(plan.length, 1);
		const [page] = plan;
		assert.ok(page!.width <= SKETCH_MAX_EDGE && page!.height <= SKETCH_MAX_EDGE);
		// The crop starts at the ink, not the canvas origin.
		assert.ok(page!.width < 1000, `cropped width ${page!.width}`);
		assert.match(page!.svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
		assert.match(page!.svg, /fill="#ffffff"/, "white background");
	});

	it("enlarges a tiny sketch, but never past 2x", () => {
		const [page] = planSketch(payload([line(0, 0, 40, 0)]));
		assert.ok(page!.width > 40 && page!.width <= 2 * (40 + 60), `width ${page!.width}`);
	});

	it("cuts a tall page into bands at blank rows", () => {
		// Rows of writing 300 px apart down a 5000 px page.
		const strokes = Array.from({ length: 17 }, (_, i) => line(0, i * 300, 800, i * 300 + 40));
		const plan = planSketch(payload(strokes));
		assert.ok(plan.length > 1 && plan.length <= SKETCH_MAX_PAGES, `${plan.length} pages`);
		for (const page of plan) assert.ok(page.height <= SKETCH_MAX_EDGE, `page height ${page.height}`);
	});

	it("refuses a sketch that needs more than the page limit", () => {
		const strokes = Array.from({ length: 60 }, (_, i) => line(0, i * 300, 800, i * 300 + 40));
		assert.throws(() => planSketch(payload(strokes)), /too tall/);
		assert.throws(() => parseSketchPayload(payload(strokes)), SketchPayloadError, "validation runs the plan");
	});
});

describe("sketchRefOf", () => {
	it("is deterministic across copies (the optimistic card and the record agree)", () => {
		const p = payload([line(5, 5, 300, 120), line(20, 200, 260, 210)]);
		const copy = JSON.parse(JSON.stringify(p)) as SketchPayload;
		assert.equal(JSON.stringify(sketchRefOf(p)), JSON.stringify(sketchRefOf(copy)));
		const ref = sketchRefOf(p);
		assert.equal(ref.strokeCount, 2);
		assert.equal(ref.pointCount, 24);
		assert.ok(isSketchRef(ref));
		assert.ok(!isSketchRef({ id: "x", pages: [] }));
	});
});

// ─── the model projection ────────────────────────────────────────────────────

const ref = sketchRefOf(payload([line(5, 5, 300, 120)]));
const png = { data: "iVBORw0KGgo=", mimeType: "image/png" };

describe("toLlmMessages with sketches", () => {
	it("puts a practice submission's pages ahead of its thinking", () => {
		const marker = { ...newThinkingMessage("call-p", "my working", ref), id: "m1" };
		const [msg] = toLlmMessages([marker as AgentMessage], { sketchImage: () => png }) as UserMessage[];
		const blocks = msg!.content as Array<{ type: string; text?: string }>;
		assert.deepEqual(blocks.map((b) => b.type), ["text", "image", "text"]);
		assert.equal(blocks[0]!.text, sketchLabel(ref.id, 0, 1));
		assert.match(blocks[2]!.text!, /my working/);
		assert.match(blocks[2]!.text!, new RegExp(`Handwritten sketch ${ref.id}`));
	});

	it("a sketch-only submission still names itself", () => {
		const marker = newThinkingMessage("call-p", "", ref);
		assert.match(marker.content as string, /no words — see the sketch/);
		assert.equal((marker.details as { text: string }).text, "");
	});

	it("appends an answer's pages after its JSON", () => {
		const answer: QuestionAnswerData = { kind: "explain", text: "see sketch", sketch: ref } as QuestionAnswerData;
		const result = newAnswerResult("call-q", "explain", answer);
		const [msg] = toLlmMessages([result as AgentMessage], { sketchImage: () => png }) as ToolResultMessage[];
		assert.deepEqual(msg!.content.map((b) => b.type), ["text", "text", "image"]);
		const json = JSON.parse((msg!.content[0] as { text: string }).text) as Record<string, unknown>;
		// Verdict-first order: the sketch closes the answer's own fields (only
		// the prose gate's `next` instruction follows it).
		assert.equal(Object.keys(json).filter((k) => k !== "next").at(-1), "sketch");
		assert.deepEqual(json.sketch, { id: ref.id, pages: 1, as: "answer" });
	});

	it("degrades a missing page to a text stub, never a throw", () => {
		const marker = newThinkingMessage("call-p", "x", ref);
		for (const resolver of [undefined, () => null, () => { throw new Error("disk"); }]) {
			const [msg] = toLlmMessages([marker as AgentMessage], { sketchImage: resolver }) as UserMessage[];
			const blocks = msg!.content as Array<{ type: string; text?: string }>;
			assert.deepEqual(blocks.map((b) => b.type), ["text", "text"]);
			assert.match(blocks[0]!.text!, /image unavailable/);
		}
	});

	it("attaches only the newest SKETCH_MAX_REQUEST_PAGES pages; older ones become stubs", () => {
		const markers = Array.from({ length: SKETCH_MAX_REQUEST_PAGES + 5 }, (_, i) => {
			const id = `sk_window${String(i).padStart(10, "0")}`;
			return { ...newThinkingMessage("c", `t${i}`, { ...ref, id }), id: `m${i}` } as AgentMessage;
		});
		const out = toLlmMessages(markers, { sketchImage: () => png }) as UserMessage[];
		const images = out.map((m) => (m.content as Array<{ type: string }>).filter((b) => b.type === "image").length);
		assert.deepEqual(images, [...Array(5).fill(0), ...Array(SKETCH_MAX_REQUEST_PAGES).fill(1)]);
		assert.match(JSON.stringify(out[0]!.content), /omitted — older than the newest 20 sketch pages/);
		assert.equal(requestSketchPages(markers).length, SKETCH_MAX_REQUEST_PAGES);
		assert.equal(estimateSketchRequestTokens(markers), SKETCH_MAX_REQUEST_PAGES * sketchPageTokens(ref.pages[0]!.width, ref.pages[0]!.height));
	});

	it("reads the sketch off markers and answers only", () => {
		assert.equal(sketchOfMessage(newThinkingMessage("c", "x", ref) as AgentMessage)?.id, ref.id);
		assert.equal(sketchOfMessage(newThinkingMessage("c", "x") as AgentMessage), null);
		assert.equal(sketchOfMessage({ role: "user", content: "hi", timestamp: 1 } as AgentMessage), null);
	});
});

// ─── the answer record + dock gate ───────────────────────────────────────────

describe("the answer record", () => {
	it("marks a select-mode sketch as thinking", () => {
		const out = compactAnswerForModel({ kind: "quiz", values: ["a"], options: [{ value: "a", label: "A" }], sketch: ref } as unknown as QuestionAnswerData);
		assert.deepEqual(out.sketch, { id: ref.id, pages: 1, as: "thinking" });
	});

	it("lets text mode submit on a sketch alone", () => {
		const base = { kind: "explain" as const, mode: "text" as const, sel: { selected: new Set<number>(), otherSelected: false, dontKnow: false }, other: "", text: "", confidenceSet: false };
		assert.equal(dockSubmitGate(base).canSubmit, false);
		assert.equal(dockSubmitGate({ ...base, hasSketch: true }).canSubmit, true);
	});
});

// ─── the input events ────────────────────────────────────────────────────────

describe("parseChatInput with sketches", () => {
	const strokes = [line(5, 5, 300, 120)];

	it("a thinking input may carry only a sketch; without one it needs text", () => {
		const parsed = parseChatInput({ type: "thinking", problemCallId: "c1", text: "", sketch: payload(strokes) });
		assert.equal(parsed.type, "thinking");
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "c1", text: "" }), ChatInputError);
	});

	it("a bad sketch is the honest 400", () => {
		assert.throws(
			() => parseChatInput({ type: "thinking", problemCallId: "c1", text: "x", sketch: { id: "bad" } }),
			(err: unknown) => err instanceof ChatInputError && /sketch id/.test((err as Error).message),
		);
	});

	it("the server derives the answer's ref — a client-sent one is replaced", () => {
		const forged = { id: "sk_forgedforgedforged", producer: "web-canvas", pages: [{ width: 1, height: 1 }], strokeCount: 1, pointCount: 1 };
		const parsed = parseChatInput({ type: "answer", toolCallId: "q1", answer: { kind: "explain", text: "", sketch: forged }, sketch: payload(strokes) });
		assert.equal(parsed.type, "answer");
		if (parsed.type !== "answer") return;
		assert.deepEqual(parsed.answer.sketch, sketchRefOf(payload(strokes)));
		const noSketch = parseChatInput({ type: "answer", toolCallId: "q1", answer: { kind: "explain", text: "hi", sketch: forged } });
		assert.equal((noSketch as { answer: QuestionAnswerData }).answer.sketch, undefined, "no payload, no ref");
	});

	it("the thinking marker carries the derived ref", () => {
		const problem: LhMessage[] = [
			{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "c1", name: "problem", arguments: { statement: "s" } }], timestamp: 1 } as unknown as LhMessage,
			{ id: "r1", role: "toolResult", toolCallId: "c1", toolName: "problem", content: [{ type: "text", text: "posed" }], isError: false, timestamp: 1 } as unknown as LhMessage,
		];
		const input = parseChatInput({ type: "thinking", problemCallId: "c1", text: "", sketch: payload(strokes) });
		const appends = inputAppends({ messages: problem, kind: "practice" }, input);
		const marker = appends.at(-1)!;
		assert.deepEqual((marker as { details: { sketch: unknown } }).details.sketch, sketchRefOf(payload(strokes)));
	});
});

// ─── compaction ──────────────────────────────────────────────────────────────

describe("compaction sees sketches", () => {
	it("counts a record message's pages at their real vision cost", () => {
		assert.equal(sketchPageTokens(2000, 2000), 72 * 72, "⌈w/28⌉×⌈h/28⌉");
		const big = { ...ref, pages: [{ width: 2000, height: 1400 }, { width: 2000, height: 600 }] };
		const plain = estimateMessageTokens(newThinkingMessage("c", "words"));
		const sketched = estimateMessageTokens(newThinkingMessage("c", "words", big));
		const pages = sketchPageTokens(2000, 1400) + sketchPageTokens(2000, 600);
		// The pages' vision cost, plus the marker's own few lines of text.
		assert.ok(sketched - plain >= pages && sketched - plain <= pages + 100, `adds ${sketched - plain}, pages cost ${pages}`);
	});

	it("the wire projection is sized once: text stubs plus the request's image window", () => {
		const big = { ...ref, pages: [{ width: 2000, height: 1400 }] };
		const record = [newAnswerResult("q", "explain", { kind: "explain", text: "x", sketch: big } as QuestionAnswerData)];
		const projected = toLlmMessages(record as AgentMessage[]);
		const projectedText = projected.reduce((n, m) => n + estimateMessageTokens(m as AgentMessage), 0);
		const wire = projectedText + estimateSketchRequestTokens(record);
		const recordSide = estimateMessageTokens(record[0]!);
		assert.ok(Math.abs(wire - recordSide) < 60, `wire ${wire} vs record ${recordSide}`);
	});

	it("writes [image] for image blocks, never their base64", () => {
		const result = {
			id: "r",
			role: "toolResult",
			toolCallId: "t",
			toolName: "read",
			content: [{ type: "text", text: "the file" }, { type: "image", data: "QUFBQUFBQUFBQUFB", mimeType: "image/png" }],
			isError: false,
			timestamp: 1,
		} as unknown as LhMessage;
		const user = { id: "u", role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "QUFBQUFBQUFBQUFB", mimeType: "image/png" }], timestamp: 1 } as unknown as LhMessage;
		const text = serializeForSummary([result, user]);
		assert.ok(!text.includes("QUFBQUFB"), text);
		assert.match(text, /\[RESULT for read\] the file\n\[image\]/);
		assert.match(text, /\[LEARNER\] look\n\[image\]/);
	});
});

// ─── the kept page (Android plan M3) ─────────────────────────────────────────

describe("the kept page", () => {
	const old = line(0, 0, 400, 40);
	const fresh = line(0, 200, 400, 240);

	it("newFrom brackets the new ink in the margin and changes no page size", () => {
		const plain = planSketch(payload([old, fresh]));
		const marked = planSketch({ ...payload([old, fresh], "sk_bracket00000001"), newFrom: 1 });
		assert.match(marked[0]!.svg, /stroke="#2563eb"/, "a blue bracket");
		assert.doesNotMatch(plain[0]!.svg, /#2563eb/);
		assert.equal(marked[0]!.width, plain[0]!.width);
		assert.equal(marked[0]!.height, plain[0]!.height);
	});

	it("newFrom is validated; 0 means no bracket", () => {
		assert.throws(() => parseSketchPayload({ ...payload([old, fresh]), newFrom: 2 }), SketchPayloadError);
		assert.throws(() => parseSketchPayload({ ...payload([old, fresh]), newFrom: 0.5 }), SketchPayloadError);
		assert.equal(parseSketchPayload({ ...payload([old, fresh]), newFrom: 0 }).newFrom, undefined);
		assert.equal(parseSketchPayload({ ...payload([old, fresh]), newFrom: 1 }).newFrom, 1);
	});

	it("the stroke eraser's hit test uses distance to the polyline plus half the width", () => {
		const s = line(0, 0, 100, 0, 5, 4);
		assert.ok(sketchStrokeHit(s, 50, 8, 10), "within reach of the middle");
		assert.ok(!sketchStrokeHit(s, 50, 30, 10), "too far");
		assert.ok(sketchStrokeHit(s, 104, 0, 4), "past the end, within reach");
	});

	it("keptSketchOf: the newest sketch after the problem's pose", () => {
		const ref = (id: string) => sketchRefOf(payload([old], id));
		const pose = (id: string) =>
			({ id: `a-${id}`, role: "assistant", content: [{ type: "toolCall", id, name: "problem", arguments: { statement: "s" } }], timestamp: 1 }) as unknown as AgentMessage;
		const marker = (id: string, r: ReturnType<typeof ref>) => newThinkingMessage(id, "t", r) as unknown as AgentMessage;
		const messages = [pose("p1"), marker("p1", ref("sk_firstfirst000001")), marker("p1", ref("sk_secondsecond0001")), pose("p2")];
		assert.equal(keptSketchOf(messages.slice(0, 3), "p1")?.id, "sk_secondsecond0001");
		assert.equal(keptSketchOf(messages, "p2"), null, "a new problem starts a clean page");
		assert.equal(keptSketchOf(messages, "p9"), null);
	});

	it("a thinking input may re-send the kept page by id, never with a sketch", () => {
		const parsed = parseChatInput({ type: "thinking", problemCallId: "c1", text: "more", sketchRef: ID });
		assert.equal((parsed as { sketchRef?: string }).sketchRef, ID);
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "c1", text: "x", sketchRef: "nope" }), ChatInputError);
		assert.throws(
			() => parseChatInput({ type: "thinking", problemCallId: "c1", text: "x", sketchRef: ID, sketch: payload([old]) }),
			ChatInputError,
		);
	});
});
