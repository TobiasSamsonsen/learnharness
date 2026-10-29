/**
 * Fork addition on top of upstream's Claude CLI provider (docs/android/m14-plan.md, P8): a plain final answer does not end
 * the process. It waits, registered, and takes the same session's next user message live (no new spawn, no replay of
 * the transcript, only the new message written to stdin). Upstream kills the process after such an answer and replays.
 * A different history, a different session, or a process that held tool calls still ends or respawns as before.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";

import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { idleReuse } from "../src/agent/claude-code/fork-extensions.ts";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { createClaudeCodeStreamFunction, type RunClaude } from "../src/agent/claude-code/stream.ts";

const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };

/** An in-memory `claude -p --input-format stream-json`: answers every user line with the next reply, in the same process. */
function fakeCli(t: TestContext, replies: string[]) {
	const spawned: Array<{ userLines: string[]; killed: boolean }> = [];
	const runClaude: RunClaude = () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const record = { userLines: [] as string[], killed: false };
		spawned.push(record);
		const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
		Object.assign(child, {
			stdin,
			stdout,
			stderr,
			kill: () => {
				record.killed = true;
				setImmediate(() => child.emit("close", null));
				return true;
			},
		});
		t.after(() => (child.kill as () => boolean)());
		const write = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
		const event = (e: unknown) => write({ type: "stream_event", event: e });
		let answered = 0;
		createInterface({ input: stdin }).on("line", (line) => {
			const message = JSON.parse(line) as { type: string; request_id?: string; request?: { subtype?: string } };
			if (message.type === "control_request") {
				if (message.request?.subtype === "initialize") write({ type: "control_response", response: { request_id: message.request_id, subtype: "success" } });
				return;
			}
			record.userLines.push(line);
			const text = replies[Math.min(answered++, replies.length - 1)]!;
			event({ type: "message_start", message: { usage: {} } });
			event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
			event({ type: "content_block_stop", index: 0 });
			event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} });
			event({ type: "message_stop" });
			write({ type: "result", subtype: "success", is_error: false });
		});
		return child as never;
	};
	return { runClaude, spawned };
}

const model = CLAUDE_CODE_MODELS[0]!;

/** Idle reuse is off by default (LH_CLAUDE_IDLE_REUSE); these tests are about it switched on. */
test.before(() => { idleReuse.current = true; });
test.after(() => { idleReuse.current = false; });

async function turn(stream: ReturnType<typeof createClaudeCodeStreamFunction>, messages: Message[], sessionId = "idle-session"): Promise<AssistantMessage> {
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: [READ_TOOL] });
	for await (const event of stream(model, context, { sessionId })) {
		if (event.type === "done") return event.message;
		if (event.type === "error") assert.fail(`the turn failed: ${event.error.errorMessage}`);
	}
	return assert.fail("the stream ended without a result");
}

const user = (text: string, timestamp = 0): Message => ({ role: "user", content: text, timestamp });

test("the next user message of a session takes the idle process live: no new spawn, only the new message is written", async (t) => {
	const { runClaude, spawned } = fakeCli(t, ["first answer", "second answer"]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await turn(stream, [user("hello")]);
	assert.equal(spawned.length, 1);
	assert.equal(spawned[0]!.killed, false, "the final answer did not end the process");

	const second = await turn(stream, [user("hello"), first, user("and now a second question", 5)]);
	assert.equal(spawned.length, 1, "no second process");
	assert.equal(second.content.map((b) => (b.type === "text" ? b.text : "")).join(""), "second answer");
	assert.equal(spawned[0]!.userLines.length, 2);
	const written = JSON.parse(spawned[0]!.userLines[1]!) as { message: { content: Array<{ type: string; text: string }> } };
	assert.deepEqual(written.message.content, [{ type: "text", text: "and now a second question" }], "the live process gets only the new message, unlabelled");
});

test("a history that is not an extension, or another session, starts a fresh process and ends the idle one", async (t) => {
	const { runClaude, spawned } = fakeCli(t, ["one", "two", "three"]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await turn(stream, [user("hello")]);
	// the learner's earlier message was edited: not a prefix of what the process holds
	await turn(stream, [user("hello, edited"), first, user("next", 5)]);
	assert.equal(spawned.length, 2, "a fresh process");
	assert.equal(spawned[0]!.killed, true, "the stale idle process was ended");
	// another session never takes this session's process
	const other = await turn(stream, [user("hi")], "another-session");
	assert.ok(other);
	assert.equal(spawned.length, 3);
	assert.equal(spawned[1]!.killed, false, "the first session's new process is untouched");
});

test("a delta that is not user messages only (an assistant message in it) is replayed, not continued live", async (t) => {
	const { runClaude, spawned } = fakeCli(t, ["one", "two"]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await turn(stream, [user("hello")]);
	const extra: AssistantMessage = { ...first, content: [{ type: "text", text: "something said elsewhere" }] };
	await turn(stream, [user("hello"), first, extra, user("next", 5)]);
	assert.equal(spawned.length, 2);
	assert.equal(spawned[0]!.killed, true);
});
