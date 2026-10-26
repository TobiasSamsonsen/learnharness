/**
 * claude-code — LIVE sessions against a fake `claude` (after PR #61's test
 * approach; tests/fixtures/claude-code/fake-claude.mjs). The real provider
 * spawns the fake through LH_CLAUDE_CODE_BIN, its real MCP bridge stub
 * forwards the fake's tool calls, and the fake's event log shows which
 * process served which call:
 *   - a tool round trip continues the SAME process (the held call answered);
 *   - a learner message continues it too (written to stdin);
 *   - a call Claude Code rejects itself (never reaching the bridge) ends the
 *     process — the next call starts fresh instead of hanging;
 *   - abort kills the process; two conversations get two processes.
 */

import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type, normalizeContext, type AssistantMessage, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { sketchLabel, sketchStubText } from "../src/core/sketch.ts";
import { answeredToolUseIds, claudeCodeModels, cliWouldRunCall, closeClaudeCodeSessions, streamClaudeCode } from "../src/agent/claude-code.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fake-claude-"));
const FAKE = path.resolve("tests/fixtures/claude-code/fake-claude.mjs");
const bin =
	process.platform === "win32"
		? (fs.writeFileSync(path.join(DIR, "claude.cmd"), `@"${process.execPath}" "${FAKE}" %*\r\n`), path.join(DIR, "claude.cmd"))
		: (fs.writeFileSync(path.join(DIR, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 }), path.join(DIR, "claude"));
process.env.LH_CLAUDE_CODE_BIN = bin;
after(() => {
	closeClaudeCodeSessions(); // idle sessions live on by design — end them, or this process never exits
	fs.rmSync(DIR, { recursive: true, force: true });
});

const model = claudeCodeModels().find((m) => m.id === "claude-sonnet-5-5")!;
const tools = [{ name: "lookup", description: "Look something up.", parameters: Type.Object({ q: Type.String() }) }];

let scriptNo = 0;
let script = "";
/** A fresh script (and an empty log) for one test. */
function useScript(steps: unknown[]): void {
	script = path.join(DIR, `script-${++scriptNo}.json`);
	fs.writeFileSync(script, JSON.stringify(steps));
	process.env.FAKE_CLAUDE_SCRIPT = script;
}
const events = (): Array<{ pid: number; event: string; text?: string; types?: string[] }> =>
	fs.readFileSync(`${script}.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pids = () => [...new Set(events().map((e) => e.pid))];

beforeEach(() => {
	process.env.FAKE_CLAUDE_SCRIPT = "";
});

const user = (text: string): Message => ({ role: "user", content: text, timestamp: Date.now() });
const resultFor = (reply: AssistantMessage, text: string): ToolResultMessage => {
	const call = reply.content.find((b) => b.type === "toolCall")!;
	return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
};
async function call(messages: Message[], sessionId: string, signal?: AbortSignal): Promise<AssistantMessage> {
	const context = normalizeContext({ systemPrompt: "You are a tutor.", tools, messages });
	return streamClaudeCode(model, context, { sessionId, signal }).result();
}
const textOf = (m: AssistantMessage) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");

test("pure guards: which calls Claude Code would run itself, and which ids a user line answers", () => {
	assert.equal(cliWouldRunCall(tools, { type: "toolCall", id: "a", name: "lookup", arguments: { q: "x" } }), true);
	assert.equal(cliWouldRunCall(tools, { type: "toolCall", id: "a", name: "lookup", arguments: { q: ["x"] } }), false, "schema-invalid");
	assert.equal(cliWouldRunCall(tools, { type: "toolCall", id: "a", name: "nope", arguments: {} }), false, "unknown tool");
	assert.deepEqual(answeredToolUseIds({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1" }, { type: "text", text: "x" }] } }), ["t1"]);
	assert.deepEqual(answeredToolUseIds({ type: "user", parent_tool_use_id: "sub", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }), [], "subagent traffic is not ours");
	assert.deepEqual(answeredToolUseIds({ type: "assistant", message: {} }), []);
});

test("a tool round trip and a learner message continue the SAME process", async () => {
	useScript([{ call: { name: "lookup", args: { q: "rest" } } }, { text: "It is 2." }, { text: "Next one." }]);
	const history: Message[] = [user("teach me")];
	const first = await call(history, "chat_live");
	assert.equal(first.stopReason, "toolUse");
	history.push(first, resultFor(first, "r = 2"));
	const second = await call(history, "chat_live");
	assert.equal(textOf(second), "It is 2.");
	history.push(second, user("go on"));
	const third = await call(history, "chat_live");
	assert.equal(textOf(third), "Next one.");
	assert.equal(pids().length, 1, "one process served the whole conversation");
	assert.deepEqual(
		events().map((e) => e.event),
		["spawn", "input", "mcp-call", "mcp-reply", "input"],
	);
	assert.equal(events().find((e) => e.event === "mcp-reply")!.text, "r = 2", "the held call got the app's result");
});

test("sketch pages ride a held call's MCP reply and a learner message as images, on the SAME process", async () => {
	// The Android plan's M1: an answer's sketch pages are image blocks
	// appended to its tool result, a practice submission's lead its user
	// message — both must continue the live process, images intact.
	useScript([{ call: { name: "lookup", args: { q: "sketch" } } }, { text: "I read your sketch." }, { text: "And this one." }]);
	const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
	const history: Message[] = [user("teach me")];
	const first = await call(history, "chat_sketch");
	const answer = resultFor(first, '{"kind":"explain","sketch":{"id":"sk_test","pages":1,"as":"answer"}}');
	history.push(first, { ...answer, content: [...answer.content, { type: "text", text: "[sketch sk_test · page 1/1]" }, image] });
	const second = await call(history, "chat_sketch");
	assert.equal(textOf(second), "I read your sketch.");
	history.push(second, { role: "user", content: [{ type: "text", text: "[sketch sk_test2 · page 1/1]" }, image, { type: "text", text: "Your thinking: here" }], timestamp: Date.now() });
	const third = await call(history, "chat_sketch");
	assert.equal(textOf(third), "And this one.");
	assert.equal(pids().length, 1, "one process served the whole conversation");
	assert.deepEqual(events().find((e) => e.event === "mcp-reply")!.types, ["text", "text", "image"], "the held call's reply carries the page");
	assert.deepEqual(events().filter((e) => e.event === "input").at(-1)!.types, ["text", "image", "text"], "the learner message carries the page");
});

test("a dispute's re-sent page reaches a live process whose replay carried the sketch as a stub", async () => {
	// Android plan M2 (advisor review): a fresh process replays a closed,
	// confirmed sketch as a text stub; the learner later disputes it. The
	// fingerprint hides image-vs-stub, so the live process CONTINUES — the
	// page must therefore arrive in the dispute's own new message.
	useScript([{ text: "Noted." }, { text: "Re-read: x cubed." }]);
	const id = "sk_disputelive00001";
	const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
	const history: Message[] = [
		user("teach me"),
		{ role: "user", content: [{ type: "text", text: sketchStubText(id, 0, 1, "elided") }, { type: "text", text: "Your thinking: my work" }], timestamp: Date.now() },
	];
	const first = await call(history, "chat_dispute");
	assert.equal(textOf(first), "Noted.");
	history.push(first, {
		role: "user",
		content: [{ type: "text", text: sketchLabel(id, 0, 1) }, image, { type: "text", text: `[The learner says your reading of sketch ${id} is wrong.]` }],
		timestamp: Date.now(),
	});
	const second = await call(history, "chat_dispute");
	assert.equal(textOf(second), "Re-read: x cubed.");
	assert.equal(pids().length, 1, "the process was reused, not respawned");
	const inputs = events().filter((e) => e.event === "input");
	assert.deepEqual(inputs.at(-1)!.types, ["text", "image", "text"], "the page went down stdin with the dispute");
});

test("a call Claude Code rejects itself ends the process — the next call starts fresh instead of hanging", async () => {
	useScript([{ reject: { name: "lookup", args: { q: 7 } } }, { text: "moved on by itself" }, { text: "Fixed it." }]);
	const history: Message[] = [user("teach me")];
	const first = await call(history, "chat_reject");
	assert.equal(first.stopReason, "toolUse", "the app still sees (and runs) the call");
	history.push(first, { ...resultFor(first, "invalid arguments"), isError: true });
	const second = await Promise.race([
		call(history, "chat_reject"),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("hung waiting on a call that never reaches the bridge")), 8000)),
	]);
	assert.equal(textOf(second), "Fixed it.", "the fresh process answered — never the CLI's own continuation");
	assert.equal(pids().length, 2, "a second process");
	assert.equal(events().filter((e) => e.event === "mcp-call").length, 0, "the rejected call never reached the bridge");
});

test("a rejection that lands after the app sent its results: the bound call restarts on a fresh process", async () => {
	// args pi accepts (so the settle check passes) — Claude Code's stricter check rejects them late
	useScript([{ lateReject: { name: "lookup", args: { q: "ok" }, delayMs: 400 } }, { text: "its own continuation" }, { text: "From a fresh start." }]);
	const history: Message[] = [user("teach me")];
	const first = await call(history, "chat_late");
	assert.equal(first.stopReason, "toolUse");
	history.push(first, resultFor(first, "app result"));
	const second = await call(history, "chat_late");
	assert.equal(textOf(second), "From a fresh start.", `nothing of the CLI's own continuation reached the turn — ${JSON.stringify({ stop: second.stopReason, err: second.errorMessage, log: events() })}`);
	assert.equal(pids().length, 2);
});

test("abort kills the process; two conversations get two processes", async () => {
	useScript([{ call: { name: "lookup", args: { q: "a" } } }, { call: { name: "lookup", args: { q: "b" } } }]);
	const [a, b] = await Promise.all([call([user("one")], "chat_a"), call([user("two")], "chat_b")]);
	assert.equal(a.stopReason, "toolUse");
	assert.equal(b.stopReason, "toolUse");
	assert.equal(pids().length, 2, "a process per conversation");

	useScript([{ call: { name: "lookup", args: { q: "slow" } } }]);
	const controller = new AbortController();
	const history: Message[] = [user("three")];
	const first = await call(history, "chat_abort");
	history.push(first, resultFor(first, "x"));
	// the script is exhausted: the continuation never replies — abort it
	const pending = call(history, "chat_abort", controller.signal);
	setTimeout(() => controller.abort(), 300);
	const aborted = await pending;
	assert.equal(aborted.stopReason, "aborted");
});
