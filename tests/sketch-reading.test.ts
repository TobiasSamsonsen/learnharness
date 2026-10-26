/**
 * Sketch readings — Android plan M2 (2026-10-26): the read_sketch tool,
 * the conclude gate, the dispute input, replay elision, and the
 * fingerprint that lets a sketch change form without breaking a live
 * Claude Code session.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { messageFingerprint } from "../src/agent/claude-code.ts";
import { createPlacementAgent, createPracticeAgent, createProberAgent, createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import { readSketchTool } from "../src/agent/tools/sketch.ts";
import {
	ChatInputError,
	SKETCH_MAX_REQUEST_PAGES,
	inputAppends,
	isConfirmed,
	newAnswerResult,
	newSketchDisputeMarker,
	newThinkingMessage,
	parseChatInput,
	serializeForSummary,
	sketchConcludeProblems,
	sketchGateOf,
	sketchIdsOf,
	sketchLabel,
	sketchRefOf,
	sketchReplayPlan,
	sketchStatesOf,
	sketchStubText,
	toLlmMessages,
	type LhMessage,
	type QuestionAnswerData,
	type SketchPayload,
} from "../src/core/index.ts";

// ─── record builders ─────────────────────────────────────────────────────────

const STAMPS = { api: "faux", provider: "faux", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" } as const;
let n = 0;
const nextId = () => `msg_${++n}`;

const call = (id: string, name: string, args: unknown): LhMessage =>
	({ id: nextId(), role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: ++n, ...STAMPS }) as unknown as LhMessage;
const result = (id: string, name: string, text = "ok", details: unknown = null, isError = false): LhMessage =>
	({ id: nextId(), role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], details, isError, timestamp: ++n }) as unknown as LhMessage;

const payload = (id: string): SketchPayload => ({
	id,
	producer: "web-canvas",
	strokes: [{ size: 4, points: [10, 10, 0.5, 120, 60, 0.6, 240, 20, 0.5] }],
});
const SK1 = "sk_reading000000001";
const SK2 = "sk_reading000000002";
const ref1 = sketchRefOf(payload(SK1));
const ref2 = sketchRefOf(payload(SK2));

/** A practice record: problem posed (call_p1) and acked. */
const posed = (callId = "call_p1"): LhMessage[] => [call(callId, "problem", { statement: "Show…" }), result(callId, "problem", "Problem posed", null)];
const thinking = (problemCallId: string, ref = ref1, text = "my work"): LhMessage => ({ ...newThinkingMessage(problemCallId, text, ref), id: nextId() }) as LhMessage;
const readCall = (callId: string, sketchId: string, uncertain: string[] = [], reading = "$x^2$"): LhMessage[] => [
	call(callId, "read_sketch", { sketchId, reading, uncertain }),
	result(callId, "read_sketch", "Reading recorded."),
];
const dispute = (sketchId: string, text?: string): LhMessage => ({ ...newSketchDisputeMarker(sketchId, text), id: nextId() }) as LhMessage;
const asAgent = (m: readonly LhMessage[]) => m as unknown as AgentMessage[];

// ─── the fold ────────────────────────────────────────────────────────────────

describe("sketchStatesOf", () => {
	it("counts a read only through its clean result", () => {
		const unanswered = [...posed(), thinking("call_p1"), call("call_r1", "read_sketch", { sketchId: SK1, reading: "x", uncertain: [] })];
		assert.equal(sketchStatesOf(asAgent(unanswered)).get(SK1), undefined, "a dangling call is no reading");
		const errored = [...unanswered, result("call_r1", "read_sketch", "bad", null, true)];
		assert.equal(sketchStatesOf(asAgent(errored)).get(SK1), undefined, "an errored one neither");
		const clean = [...posed(), thinking("call_p1"), ...readCall("call_r2", SK1, [], "$y$")];
		const state = sketchStatesOf(asAgent(clean)).get(SK1)!;
		assert.equal(state.read?.reading, "$y$");
		assert.ok(isConfirmed(state));
	});

	it("a dispute opens until a newer read; doubts block confirmation", () => {
		const base = [...posed(), thinking("call_p1"), ...readCall("call_r1", SK1)];
		assert.ok(isConfirmed(sketchStatesOf(asAgent(base)).get(SK1)));
		const disputed = [...base, dispute(SK1, "it was x^3")];
		const state = sketchStatesOf(asAgent(disputed)).get(SK1)!;
		assert.equal(state.disputed, true);
		assert.ok(!isConfirmed(state));
		const reread = [...disputed, ...readCall("call_r2", SK1, [], "$x^3$")];
		assert.ok(isConfirmed(sketchStatesOf(asAgent(reread)).get(SK1)), "a newer read clears the dispute");
		const doubtful = [...base.slice(0, -2), ...readCall("call_r3", SK1, ["the exponent"])];
		assert.ok(!isConfirmed(sketchStatesOf(asAgent(doubtful)).get(SK1)), "doubts keep it open");
	});

	it("knows every sketch the record carries", () => {
		const record = [...posed(), thinking("call_p1", ref1), { ...newAnswerResult("q1", "explain", { kind: "explain", text: "", sketch: ref2 } as QuestionAnswerData), id: nextId() } as LhMessage];
		assert.deepEqual([...sketchIdsOf(asAgent(record))].sort(), [SK1, SK2]);
	});
});

// ─── the conclude gate ───────────────────────────────────────────────────────

describe("the conclude gate", () => {
	it("gates the ACTIVE problem's newest sketch only", () => {
		const record = [...posed("call_p0"), thinking("call_p0", ref1), ...posed("call_p1"), thinking("call_p1", ref2)];
		assert.equal(sketchGateOf(asAgent(record), "call_p1")?.id, SK2, "the newest sketch on the active problem");
		assert.equal(sketchGateOf(asAgent(record), "call_p9"), null, "no sketch on that problem");
		assert.equal(sketchGateOf(asAgent(record), null), null, "no active problem");
	});

	it("unread / doubtful / disputed / read — the verdicts", () => {
		const gate = (extra: LhMessage[]) => sketchGateOf(asAgent([...posed(), thinking("call_p1"), ...extra]), "call_p1");
		assert.match(sketchConcludeProblems(gate([]), "solved")[0]!, /unread/);
		assert.match(sketchConcludeProblems(gate(readCall("r", SK1, ["the 3"])), "solvedWithHints")[0]!, /open doubts/);
		assert.match(sketchConcludeProblems(gate([...readCall("r", SK1), dispute(SK1)]), "solved")[0]!, /disputed/);
		assert.deepEqual(sketchConcludeProblems(gate(readCall("r", SK1)), "solved"), []);
		// Only credit is gated: a surrender or a move-on is not.
		for (const outcome of ["movedOn", "surrendered", "dismissed"]) assert.deepEqual(sketchConcludeProblems(gate([]), outcome), []);
		assert.deepEqual(sketchConcludeProblems(null, "solved"), [], "no sketch, no gate");
	});

	const CONCLUDE = { outcome: "solved", verdict: "ok", rung: null, missClass: null, retest: false } as const;
	const toolsFor = (record: LhMessage[]) =>
		practiceTools({ chatId: "c1", chatStore: { getChat: () => ({ messages: record, kind: "practice" }) } }) as unknown as Record<
			string,
			{ execute: (id: string, input: unknown) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }> }
		>;

	it("refuses conclude until read_sketch ran — also in the same batch, in order", async () => {
		const tools = toolsFor([...posed(), thinking("call_p1")]);
		const refused = await tools.conclude!.execute("c1", CONCLUDE);
		assert.equal(refused.isError, true);
		assert.match(refused.content[0]!.text!, /unread/);
		// The model's batch: read_sketch, then conclude — the closure sees the read.
		const read = await tools.read_sketch!.execute("r1", { sketchId: SK1, reading: "$x^2$", uncertain: [] });
		assert.notEqual(read.isError, true);
		const ok = await tools.conclude!.execute("c2", CONCLUDE);
		assert.notEqual(ok.isError, true, "read, then concluded in the same turn");
	});

	it("a doubtful read still blocks; a clean re-read unblocks", async () => {
		const tools = toolsFor([...posed(), thinking("call_p1")]);
		await tools.read_sketch!.execute("r1", { sketchId: SK1, reading: "$x^?$", uncertain: ["the exponent"] });
		assert.equal((await tools.conclude!.execute("c1", CONCLUDE)).isError, true);
		await tools.read_sketch!.execute("r2", { sketchId: SK1, reading: "$x^2$", uncertain: [] });
		assert.notEqual((await tools.conclude!.execute("c2", CONCLUDE)).isError, true);
	});

	it("movedOn is never gated, and a sketch-free problem concludes as before", async () => {
		const gated = toolsFor([...posed(), thinking("call_p1")]);
		assert.notEqual((await gated.conclude!.execute("c1", { ...CONCLUDE, outcome: "movedOn" })).isError, true);
		const free = toolsFor(posed());
		assert.notEqual((await free.conclude!.execute("c1", CONCLUDE)).isError, true);
	});

	it("an already-read, undisputed sketch seeds the gate open; a dispute seeds it shut", async () => {
		const read = [...posed(), thinking("call_p1"), ...readCall("r0", SK1)];
		assert.notEqual((await toolsFor(read).conclude!.execute("c1", CONCLUDE)).isError, true);
		const disputed = [...read, dispute(SK1)];
		assert.equal((await toolsFor(disputed).conclude!.execute("c1", CONCLUDE)).isError, true);
	});
});

// ─── the read_sketch tool ────────────────────────────────────────────────────

describe("read_sketch", () => {
	const tool = (ids: string[], onRead?: (id: string, u: readonly string[]) => void) => readSketchTool({ known: () => new Set(ids), onRead });

	it("acks a known sketch (with the doubt instruction when unsure) and rejects the rest", async () => {
		const t = tool([SK1]);
		const clean = await t.execute("c", { sketchId: SK1, reading: "$x$", uncertain: [] });
		assert.equal(clean.isError, undefined);
		assert.match((clean.content[0] as { text: string }).text, /^Reading recorded\./);
		const doubt = await t.execute("c", { sketchId: SK1, reading: "$x$", uncertain: ["a"] });
		assert.match((doubt.content[0] as { text: string }).text, /ask the learner/);
		assert.equal((await t.execute("c", { sketchId: "sk_unknown00000000", reading: "x", uncertain: [] })).isError, true);
		assert.equal((await t.execute("c", { sketchId: SK1, reading: "  ", uncertain: [] })).isError, true);
	});

	it("reports a successful read to its gate, and only then", async () => {
		const seen: string[] = [];
		const t = tool([SK1], (id) => seen.push(id));
		await t.execute("c", { sketchId: "sk_nope000000000000", reading: "x", uncertain: [] });
		assert.deepEqual(seen, []);
		await t.execute("c", { sketchId: SK1, reading: "x", uncertain: [] });
		assert.deepEqual(seen, [SK1]);
	});

	it("rides every agent, always", () => {
		const faux = createFauxCore({});
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const names = (agent: { state: { tools: Array<{ name: string }> } }) => agent.state.tools.map((t) => t.name);
		const record = { messages: [] as LhMessage[], kind: "practice" };
		assert.ok(names(createTeacherAgent(undefined, { engine })).includes("read_sketch"), "teacher");
		assert.ok(names(createPlacementAgent({ skills: () => [] }, { engine })).includes("read_sketch"), "placement");
		assert.ok(names(createPracticeAgent({ chatId: "c1", chatStore: { getChat: () => record } }, { engine })).includes("read_sketch"), "practice");
		const proberCtx = { chatId: "c1", chatStore: { getChat: () => record } } as unknown as Parameters<typeof createProberAgent>[0];
		assert.ok(names(createProberAgent(proberCtx, { engine })).includes("read_sketch"), "prober");
		// A caller-owned registry is never touched.
		assert.ok(!names(createTeacherAgent(undefined, { engine, tools: {} })).includes("read_sketch"));
	});
});

// ─── the dispute input ───────────────────────────────────────────────────────

describe("the dispute input", () => {
	const readRecord = [...posed(), thinking("call_p1"), ...readCall("call_r1", SK1)];

	it("parses, trims to nothing, and rejects the malformed", () => {
		assert.deepEqual(parseChatInput({ type: "dispute", sketchId: SK1, text: "x^3" }), { type: "dispute", sketchId: SK1, text: "x^3" });
		assert.deepEqual(parseChatInput({ type: "dispute", sketchId: SK1, text: "   " }), { type: "dispute", sketchId: SK1 });
		assert.deepEqual(parseChatInput({ type: "dispute", sketchId: SK1 }), { type: "dispute", sketchId: SK1 });
		for (const bad of [{ sketchId: "nope" }, { sketchId: SK1, text: 5 }, { sketchId: SK1, text: "x".repeat(2001) }]) {
			assert.throws(() => parseChatInput({ type: "dispute", ...bad }), ChatInputError, JSON.stringify(bad).slice(0, 40));
		}
	});

	it("appends the marker only for a sketch that was read, with no question waiting", () => {
		const input = parseChatInput({ type: "dispute", sketchId: SK1, text: "it was x^3" });
		const [marker] = inputAppends({ messages: readRecord, kind: "practice" }, input);
		assert.equal((marker as { customType: string }).customType, "sketch-dispute");
		assert.deepEqual((marker as { details: unknown }).details, { sketchId: SK1, text: "it was x^3" });
		assert.match((marker as { content: string }).content, /sk_reading000000001.*«it was x\^3».*call read_sketch again/s);
		// An unread sketch cannot be disputed.
		assert.throws(() => inputAppends({ messages: [...posed(), thinking("call_p1")], kind: "practice" }, input), /has not been read/);
		// A question waiting owns the moment.
		const dangling = [...readRecord, call("q1", "quiz", { question: "?" })];
		assert.throws(() => inputAppends({ messages: dangling, kind: "practice" }, input), /no open question/);
	});

	it("reaches the model as a user message, and re-opens the sketch for replay", () => {
		const marker = dispute(SK1, "x^3");
		const [projected] = toLlmMessages([marker] as unknown as AgentMessage[]) as UserMessage[];
		assert.equal(projected!.role, "user");
	});
});

// ─── replay elision ──────────────────────────────────────────────────────────

describe("replay elision", () => {
	const png = { data: "iVBORw0KGgo=", mimeType: "image/png" };
	const imagesIn = (m: AgentMessage[]) =>
		(toLlmMessages(m, { sketchImage: () => png }) as UserMessage[]).flatMap((x) => (Array.isArray(x.content) ? x.content : [])).filter((b) => b.type === "image").length;

	it("a confirmed sketch stays an image until a newer problem is posed", () => {
		const open = [...posed(), thinking("call_p1"), ...readCall("r1", SK1)];
		assert.equal(sketchReplayPlan(asAgent(open)).size, 0, "same problem still running");
		assert.equal(imagesIn(asAgent(open)), 1);
		const closed = [...open, ...posed("call_p2")];
		assert.deepEqual([...sketchReplayPlan(asAgent(closed))], [SK1]);
		assert.equal(imagesIn(asAgent(closed)), 0, "the reading is the record");
		const text = JSON.stringify(toLlmMessages(asAgent(closed), { sketchImage: () => png }));
		assert.ok(text.includes(sketchStubText(SK1, 0, 1, "elided")));
		assert.match(text, /omitted; its confirmed reading is your read_sketch call/);
	});

	it("an unread, doubtful or disputed sketch is never elided", () => {
		const closedWith = (extra: LhMessage[]) => [...posed(), thinking("call_p1"), ...extra, ...posed("call_p2")];
		assert.equal(sketchReplayPlan(asAgent(closedWith([]))).size, 0, "unread");
		assert.equal(sketchReplayPlan(asAgent(closedWith(readCall("r1", SK1, ["the 3"])))).size, 0, "doubtful");
		assert.equal(sketchReplayPlan(asAgent(closedWith([...readCall("r1", SK1), dispute(SK1)]))).size, 0, "disputed: the re-read needs the image");
	});

	it("an answer's sketch closes when a later question is answered", () => {
		const answer = (id: string, ref: typeof ref1) => ({ ...newAnswerResult(id, "explain", { kind: "explain", text: "", sketch: ref } as QuestionAnswerData), id: nextId() }) as LhMessage;
		const first = [call("q1", "explain", { question: "?" }), answer("q1", ref1), ...readCall("r1", SK1)];
		assert.equal(sketchReplayPlan(asAgent(first)).size, 0);
		const second = [...first, call("q2", "explain", { question: "??" }), answer("q2", ref2)];
		assert.deepEqual([...sketchReplayPlan(asAgent(second))], [SK1], "only the earlier sketch; the newest is still live");
	});

	it("the 20-page window stays as the backstop over open sketches", () => {
		const many = Array.from({ length: SKETCH_MAX_REQUEST_PAGES + 3 }, (_, i) => thinking("call_p1", sketchRefOf(payload(`sk_backstop${String(i).padStart(8, "0")}`))));
		assert.equal(imagesIn(asAgent([...posed(), ...many])), SKETCH_MAX_REQUEST_PAGES);
	});
});

// ─── the fingerprint ─────────────────────────────────────────────────────────

describe("fingerprints across a sketch's forms", () => {
	const png = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
	const label = sketchLabel(SK1, 0, 1);
	const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 1 });
	const tail = { type: "text" as const, text: "Your thinking:\nhere" };

	it("an image, an elided stub, a window stub and a missing-file stub hash alike", () => {
		const asImage = messageFingerprint(user([{ type: "text", text: label }, png, tail]));
		for (const why of ["elided", "window", "missing"] as const) {
			assert.equal(messageFingerprint(user([{ type: "text", text: sketchStubText(SK1, 0, 1, why) }, tail])), asImage, why);
		}
	});

	it("still tells different sketches, pages and surrounding text apart", () => {
		const base = messageFingerprint(user([{ type: "text", text: label }, png, tail]));
		assert.notEqual(messageFingerprint(user([{ type: "text", text: sketchLabel(SK2, 0, 1) }, png, tail])), base, "another sketch");
		assert.notEqual(messageFingerprint(user([{ type: "text", text: sketchLabel(SK1, 0, 2) }, png, tail])), base, "another page count");
		assert.notEqual(messageFingerprint(user([{ type: "text", text: label }, png, { type: "text", text: "other" }])), base, "other text");
		// A bare image with no sketch label is still hashed.
		assert.notEqual(messageFingerprint(user([png, tail])), messageFingerprint(user([tail])));
	});

	it("the same holds on a tool result's content", () => {
		const r = (content: ToolResultMessage["content"]): ToolResultMessage => ({ role: "toolResult", toolCallId: "t", toolName: "explain", content, isError: false, timestamp: 1 });
		const json = { type: "text" as const, text: '{"sketch":{"id":"sk"}}' };
		assert.equal(
			messageFingerprint(r([json, { type: "text", text: label }, png])),
			messageFingerprint(r([json, { type: "text", text: sketchStubText(SK1, 0, 1, "elided") }])),
		);
	});
});

// ─── compaction ──────────────────────────────────────────────────────────────

describe("compaction writes the reading, not the pixels", () => {
	it("[sketch … — read as: …] when read, [sketch … — not read] when not", () => {
		const record = [...posed(), thinking("call_p1", ref1), ...readCall("r1", SK1, ["the 3"], "$x^2$"), thinking("call_p1", ref2)];
		const text = serializeForSummary(record);
		assert.match(text, /\[sketch sk_reading000000001 — read as: \$x\^2\$ \(doubts: the 3\)\]/);
		assert.match(text, /\[sketch sk_reading000000002 — not read\]/);
	});
});
