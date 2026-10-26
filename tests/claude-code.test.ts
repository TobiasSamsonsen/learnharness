/**
 * claude-code — the subscription provider's pure halves (fork addition).
 *
 * No CLI is spawned here: the request renderer (pi transcript → one
 * Claude Code request) and the stream translator (recorded stream-json
 * lines → pi events) are pinned in isolation, plus the catalog shape.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Type, createAssistantMessageEventStream, normalizeContext, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
	CLAUDE_CODE_PROVIDER_ID,
	ClaudeCodeTranslator,
	claudeCodeEffort,
	claudeCodeModels,
	parseMaxSessions,
	renderClaudeCodeRequest,
	renderToolCallRecord,
	salvageTextToolCalls,
	visibleStreamText,
} from "../src/agent/claude-code.ts";

const model = claudeCodeModels().find((m) => m.id === "claude-sonnet-5-5")!;

test("the catalog mirrors pi-ai's Anthropic models at zero cost, dated aliases dropped", () => {
	const models = claudeCodeModels();
	assert.ok(models.length > 0);
	assert.ok(model, "the current Sonnet is listed");
	for (const m of models) {
		assert.equal(m.provider, CLAUDE_CODE_PROVIDER_ID);
		assert.deepEqual([m.cost.input, m.cost.output, m.cost.cacheRead, m.cost.cacheWrite], [0, 0, 0, 0]);
		assert.doesNotMatch(m.id, /-\d{8}$/);
	}
});

test("the renderer folds the system prompt + tools and flattens history into one user message", () => {
	const context = normalizeContext({
		systemPrompt: "You are a tutor.",
		tools: [{ name: "probe", description: "Ask a question.", parameters: Type.Object({ question: Type.String() }) }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "Teach me this:" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "text", text: "First a check." },
					{ type: "toolCall", id: "call_1", name: "probe", arguments: { question: "What is $\\frac{1}{2}$?" } },
				],
				api: "x",
				provider: "x",
				model: "x",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "call_1", toolName: "probe", content: [{ type: "text", text: "Answered: 4" }], isError: false, timestamp: 3 },
		],
	});
	const request = renderClaudeCodeRequest(context);
	assert.match(request.systemPrompt, /^You are a tutor\./);
	assert.match(request.systemPrompt, /mcp__lh__/);
	assert.deepEqual(request.tools.map((t) => t.name), ["probe"]);
	assert.equal(request.content.length, 3, "text, image, text");
	assert.deepEqual(request.content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
	const tail = request.content[2]!.type === "text" ? request.content[2]!.text : "";
	assert.ok(
		tail.includes('<tool_call id="call_1" name="probe">\n<parameter name="question">What is $\\frac{1}{2}$?</parameter>\n</tool_call>'),
		"string arguments verbatim — no JSON escapes for the model to copy",
	);
	assert.match(tail, /<tool_result tool_call_id="call_1" name="probe">\nAnswered: 4\n<\/tool_result>/);
	assert.doesNotMatch(tail, /private reasoning/, "agent thinking is not replayed");
});

const quizTool = {
	name: "quiz",
	description: "Pose a check.",
	parameters: Type.Object({
		type: Type.Union([Type.Literal("predict"), Type.Literal("check")]),
		question: Type.String(),
		options: Type.Array(Type.Object({ label: Type.String(), value: Type.String() })),
	}),
};

test("a tool call WRITTEN as text (the observed imitation) is recovered with schema-typed arguments", () => {
	// Verbatim shape from a live teaching session (2026-10-24).
	const leaked = [
		"The idea is that near a point, both curves behave like lines.",
		"",
		'<tool_call id="toolu_01PredictRates" name="quiz">',
		'<parameter name="type">predict</parameter>',
		'<parameter name="question">Zoom in on $y=f(g(x))$ at $x=a$. What slope, with $g\'(a)=3$?</parameter>',
		'<parameter name="options">[{"label":"Slope $15$","value":"a"},{"label":"Slope $8$","value":"b"}]</parameter>',
		"</tool_call>",
	].join("\n");
	const { text, calls } = salvageTextToolCalls(leaked, [quizTool]);
	assert.equal(text, "The idea is that near a point, both curves behave like lines.");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.name, "quiz");
	assert.match(calls[0]!.id, /^toolu_cc_/);
	assert.deepEqual(calls[0]!.arguments, {
		type: "predict",
		question: "Zoom in on $y=f(g(x))$ at $x=a$. What slope, with $g'(a)=3$?",
		options: [{ label: "Slope $15$", value: "a" }, { label: "Slope $8$", value: "b" }],
	});
	// a record round-trips through the same parser
	const record = renderToolCallRecord({ type: "toolCall", id: "x", name: "quiz", arguments: calls[0]!.arguments });
	assert.deepEqual(salvageTextToolCalls(record, [quizTool]).calls[0]!.arguments, calls[0]!.arguments);
	// unknown tools stay text; malformed JSON rides raw (tool validation judges it)
	assert.equal(salvageTextToolCalls('<tool_call name="nope"></tool_call>', [quizTool]).calls.length, 0);
	assert.deepEqual(
		salvageTextToolCalls('<tool_call name="quiz"><parameter name="options">[oops</parameter></tool_call>', [quizTool]).calls[0]!.arguments,
		{ options: "[oops" },
	);
});

test("the model's own call syntax arriving as text (an API parse miss) is recovered too", () => {
	// Verbatim shape from a live teaching session (2026-10-24): stop_reason
	// tool_use, no tool_use block, mismatched closing tags.
	const leaked = [
		"Here is the loose end.",
		"<tool_call>",
		'<invoke name="mcp__lh__quiz">',
		'<parameter name="type">check</parameter>',
		'<parameter name="question">Area spanned by $(2,5)$ and $(3,0)$?</parameter>',
		'<parameter name="options">[{"label":"$15$","value":"a"}]</parameter>',
		"</invoke>",
		"</invoke>",
	].join("\n");
	const { text, calls } = salvageTextToolCalls(leaked, [quizTool]);
	assert.equal(text, "Here is the loose end.", "wrapper debris removed");
	assert.deepEqual(calls.map((c) => c.arguments), [
		{ type: "check", question: "Area spanned by $(2,5)$ and $(3,0)$?", options: [{ label: "$15$", value: "a" }] },
	]);
});

test("the translator salvages a text-written call into a toolUse turn", async () => {
	const stream = createAssistantMessageEventStream();
	const translator = new ClaudeCodeTranslator(stream, model, [quizTool]);
	const text = 'Next a check.\n<tool_call name="mcp__lh__quiz"><parameter name="type">check</parameter><parameter name="question">Q?</parameter><parameter name="options">[]</parameter></tool_call>';
	for (const line of [
		se({ type: "message_start", message: { id: "m", usage: {} } }),
		se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		se({ type: "content_block_stop", index: 0 }),
		se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
		se({ type: "message_stop" }),
	])
		translator.push(line);
	for await (const _ of stream);
	const message = await stream.result();
	assert.equal(message.stopReason, "toolUse");
	assert.deepEqual(message.content[0], { type: "text", text: "Next a check." });
	assert.equal(message.content[1]?.type, "toolCall");
	assert.deepEqual((message.content[1] as { arguments: unknown }).arguments, { type: "check", question: "Q?", options: [] });
});

test("a record opener closed by the model's own </invoke> is recovered (live shape, 2026-10-24)", () => {
	const leaked =
		'Riktig.\n<tool_call id="toolu_cc_9a1f" name="quiz">\n<parameter name="type">check</parameter>\n<parameter name="question">Hva er ε?</parameter>\n<parameter name="options">[]</parameter>\n</invoke>';
	const { text, calls } = salvageTextToolCalls(leaked, [quizTool]);
	assert.equal(text, "Riktig.");
	assert.deepEqual(calls.map((c) => c.arguments), [{ type: "check", question: "Hva er ε?", options: [] }]);
});

test("streaming never shows text-written call markup, not even a tag's first letters", () => {
	assert.equal(visibleStreamText("Next a check. <inv"), "Next a check. ");
	assert.equal(visibleStreamText("Next a check. <tool_call name"), "Next a check. ");
	assert.equal(visibleStreamText("a < b and $x<1$"), "a < b and $x<1$", "ordinary < stays visible");
	assert.equal(visibleStreamText("Plain prose."), "Plain prose.");
});

/** Drive one text block through the translator in small deltas. */
async function translateText(text: string, extra: Record<string, unknown>[] = []) {
	const stream = createAssistantMessageEventStream();
	const translator = new ClaudeCodeTranslator(stream, model, [quizTool]);
	const lines = [
		se({ type: "message_start", message: { id: "m", usage: {} } }),
		se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		...Array.from(text.match(/[\s\S]{1,7}/g) ?? [], (chunk) => se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } })),
		se({ type: "content_block_stop", index: 0 }),
		...extra,
		se({ type: "message_delta", delta: { stop_reason: extra.length ? "tool_use" : "end_turn" }, usage: {} }),
		se({ type: "message_stop" }),
	];
	for (const line of lines) translator.push(line);
	const events: AssistantMessageEvent[] = [];
	for await (const e of stream) events.push(e);
	return { events, message: await stream.result() };
}

test("a text-written call streams as prose only and arrives as a real call", async () => {
	const { events, message } = await translateText(
		'Next a check.\n<tool_call name="quiz"><parameter name="type">check</parameter><parameter name="question">Q?</parameter><parameter name="options">[]</parameter></tool_call>',
	);
	const streamed = events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta).join("");
	assert.equal(streamed, "Next a check.\n");
	const end = events.find((e) => e.type === "text_end") as { content: string };
	assert.equal(end.content, "Next a check.");
	assert.ok(events.some((e) => e.type === "toolcall_end"), "the recovered call is announced");
	assert.equal(message.stopReason, "toolUse");
	assert.equal(message.content[1]?.type, "toolCall");
});

test("a native call plus a text-written duplicate keeps only the native call, and no markup", async () => {
	const { message } = await translateText('Check:\n<invoke name="mcp__lh__quiz"><parameter name="type">check</parameter></invoke>', [
		se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_native", name: "mcp__lh__quiz", input: {} } }),
		se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"type":"check"}' } }),
		se({ type: "content_block_stop", index: 1 }),
	]);
	assert.deepEqual(message.content, [
		{ type: "text", text: "Check:" },
		{ type: "toolCall", id: "toolu_native", name: "quiz", arguments: { type: "check" } },
	]);
});

test("thinking levels map to --effort through the model's own map", () => {
	assert.equal(claudeCodeEffort(model, undefined), undefined);
	assert.equal(claudeCodeEffort(model, "high"), "high");
	assert.equal(claudeCodeEffort(model, "max"), "max");
	assert.equal(claudeCodeEffort(model, "minimal"), "low");
});

/** A recorded tool-use turn, trimmed to the lines the translator reads. */
const se = (event: unknown, extra: Record<string, unknown> = {}) => ({ type: "stream_event", event, parent_tool_use_id: null, ...extra });
const TOOL_TURN = [
	{ type: "system", subtype: "init" },
	se({ type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 1 } } }),
	se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
	se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } }),
	se({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
	se({ type: "content_block_stop", index: 0 }),
	se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
	se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Let me " } }),
	se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "check." } }),
	se({ type: "content_block_stop", index: 1 }),
	se({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__lh__probe", input: {} } }),
	se({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"question": "2+' } }),
	{ type: "assistant", message: { content: [] } },
	se({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '2?"}' } }),
	se({ type: "content_block_stop", index: 2 }),
	se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 40, output_tokens_details: { thinking_tokens: 10 } } }),
	se({ type: "message_stop" }),
	// Claude Code's own loop continues past here — the translator must ignore it
	se({ type: "message_start", message: { id: "msg_2", usage: {} } }),
];

async function collect(lines: Record<string, unknown>[]) {
	const stream = createAssistantMessageEventStream();
	const translator = new ClaudeCodeTranslator(stream, model);
	for (const line of lines) translator.push(line);
	const events: AssistantMessageEvent[] = [];
	if (!translator.finished) translator.fail("Claude Code exited (code 1) before finishing the turn");
	for await (const e of stream) events.push(e);
	return { events, message: await stream.result() };
}

test("a tool-use turn translates to pi events and a toolUse stop with unprefixed tool names", async () => {
	const { events, message } = await collect(TOOL_TURN);
	assert.deepEqual(
		events.map((e) => e.type).filter((t, i, a) => t !== a[i - 1]),
		["start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"],
		"empty thinking (signature only) emits no thinking block",
	);
	assert.equal(message.stopReason, "toolUse");
	assert.equal(message.responseId, "msg_1");
	assert.deepEqual(message.content, [
		{ type: "text", text: "Let me check." },
		{ type: "toolCall", id: "toolu_1", name: "probe", arguments: { question: "2+2?" } },
	]);
	assert.equal(message.usage.output, 40);
	assert.equal(message.usage.cacheWrite, 100);
	assert.equal(message.usage.reasoning, 10);
	assert.equal(message.usage.cost.total, 0);
});

test("a run that dies before message_stop fails with the CLI's own error text", async () => {
	const { events, message } = await collect([
		{ type: "system", subtype: "init" },
		{ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } },
		{ type: "result", is_error: true, result: "Not logged in · Please run /login" },
	]);
	assert.equal(events.at(-1)?.type, "error");
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /before finishing the turn: Not logged in · Please run \/login/);
});

test("subagent traffic (parent_tool_use_id set) is ignored", async () => {
	const { message } = await collect([
		se({ type: "message_start", message: { id: "msg_1", usage: {} } }),
		se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { parent_tool_use_id: "toolu_x" }),
		se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
		se({ type: "content_block_stop", index: 0 }),
		se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
		se({ type: "message_stop" }),
	]);
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(message.content, [{ type: "text", text: "hi" }]);
});

// ─── live sessions (pure halves) ─────────────────────────────────────────────

test("fingerprints identify what the model saw, not record bookkeeping", async () => {
	const { messageFingerprint } = await import("../src/agent/claude-code.ts");
	const user = { role: "user" as const, content: "hi", timestamp: 1 };
	assert.equal(messageFingerprint(user), messageFingerprint({ ...user, timestamp: 2 }), "timestamps don't count");
	assert.notEqual(messageFingerprint(user), messageFingerprint({ ...user, content: "hi!" }));
	const result = { role: "toolResult" as const, toolCallId: "t1", toolName: "probe", content: [{ type: "text" as const, text: "ok" }], isError: false, timestamp: 1 };
	assert.notEqual(messageFingerprint(result), messageFingerprint({ ...result, isError: true }));
});

test("a live session continues only with exactly the results it waits for, or learner messages", async () => {
	const { continuation, isPrefixOf } = await import("../src/agent/claude-code.ts");
	const r = (id: string) => ({ role: "toolResult" as const, toolCallId: id, toolName: "x", content: [], isError: false, timestamp: 1 });
	const u = { role: "user" as const, content: "next", timestamp: 1 };
	assert.equal(continuation("awaiting-tools", ["a", "b"], [r("a"), r("b")]), "results");
	assert.equal(continuation("awaiting-tools", ["a", "b"], [r("a")]), null, "a missing result");
	assert.equal(continuation("awaiting-tools", ["a"], [r("a"), u]), null, "a message after the results: start fresh");
	assert.equal(continuation("awaiting-tools", ["a"], [r("z")]), null, "an unknown id (a salvaged call)");
	assert.equal(continuation("idle", [], [u]), "user");
	assert.equal(continuation("idle", [], [r("a")]), null);
	assert.equal(continuation("idle", [], []), null);
	assert.equal(isPrefixOf(["1", "2"], ["1", "2", "3"]), true);
	assert.equal(isPrefixOf(["1", "x"], ["1", "2", "3"]), false, "history changed (compaction): start fresh");
});

test("tool results become the MCP reply Claude Code waits for", async () => {
	const { mcpResult } = await import("../src/agent/claude-code.ts");
	const base = { role: "toolResult" as const, toolCallId: "t", toolName: "x", timestamp: 1 };
	assert.deepEqual(mcpResult({ ...base, content: [{ type: "text", text: "ok" }], isError: false }), { content: [{ type: "text", text: "ok" }] });
	assert.deepEqual(mcpResult({ ...base, content: [{ type: "image", data: "AA", mimeType: "image/png" }], isError: true }), {
		content: [{ type: "image", data: "AA", mimeType: "image/png" }],
		isError: true,
	});
});

test("LH_CLAUDE_CODE_MAX_SESSIONS: a positive integer, anything else is the default 6", () => {
	assert.equal(parseMaxSessions(undefined), 6);
	for (const bad of ["", " ", "0", "-1", "1.5", "two", "2x", "0x10", "1e3", "99999999999999999999"]) assert.equal(parseMaxSessions(bad), 6, bad);
	assert.equal(parseMaxSessions("1"), 1);
	assert.equal(parseMaxSessions(" 2 "), 2);
	assert.equal(parseMaxSessions("12"), 12);
});
