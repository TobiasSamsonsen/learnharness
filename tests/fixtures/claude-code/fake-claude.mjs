/**
 * A fake `claude -p` for the live-session tests (tests/claude-code-live.test.ts),
 * after PR #61's approach: it speaks the real CLI's stream-json protocol on
 * stdout, reads stream-json user messages on stdin, and calls tools through
 * the MCP server named in --mcp-config — the provider's real bridge stub.
 *
 * The script (FAKE_CLAUDE_SCRIPT, a JSON file) is a list of API messages,
 * consumed in order across every process the test spawns:
 *   { "text": "…" }                 a reply; the turn ends, wait for stdin
 *   { "call": { name, args } }      a tool call through MCP (held until the
 *                                   app answers), then the next message
 *   { "reject": { name, args } }    a call the CLI answers ITSELF (an error
 *                                   tool_result, no MCP), then moves on
 *   { "lateReject": { name, args, delayMs } }  the same, but its answer lands
 *                                   only after the message ended (a race)
 * Steps are claimed with <script>.step<i> marker files; <script>.log is the
 * event log the tests read (spawn, input, mcp-call, mcp-reply).
 */
import { spawn } from "node:child_process";
import { appendFileSync, openSync, closeSync, readFileSync } from "node:fs";

const scriptFile = process.env.FAKE_CLAUDE_SCRIPT;
const steps = JSON.parse(readFileSync(scriptFile, "utf8"));
const pid = process.pid;
// concurrent processes share the script: steps are CLAIMED with an
// exclusive file create, and the log is appended a line at a time
const log = (event, extra = {}) => appendFileSync(`${scriptFile}.log`, JSON.stringify({ pid, event, ...extra }) + "\n");
const nextStep = () => {
	for (let i = 0; i < steps.length; i++) {
		try {
			closeSync(openSync(`${scriptFile}.step${i}`, "wx"));
			return steps[i];
		} catch {
			// claimed already
		}
	}
	return undefined;
};
log("spawn");

const out = (obj) => process.stdout.write(JSON.stringify({ parent_tool_use_id: null, ...obj }) + "\n");
const ev = (event) => out({ type: "stream_event", event });
let msgSeq = 0;
let toolSeq = 0;

// ─── MCP: the provider's stub, started as Claude Code would ─────────────────
const argv = process.argv.slice(2);
const mcpConfig = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8"));
const [server] = Object.values(mcpConfig.mcpServers);
const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
let rpcId = 0;
const waiting = new Map();
let mcpBuf = "";
mcp.stdout.setEncoding("utf8");
mcp.stdout.on("data", (chunk) => {
	mcpBuf += chunk;
	let nl;
	while ((nl = mcpBuf.indexOf("\n")) >= 0) {
		const line = mcpBuf.slice(0, nl).trim();
		mcpBuf = mcpBuf.slice(nl + 1);
		if (!line) continue;
		const msg = JSON.parse(line);
		waiting.get(msg.id)?.(msg);
		waiting.delete(msg.id);
	}
});
const rpc = (method, params) =>
	new Promise((resolve) => {
		const id = ++rpcId;
		waiting.set(id, resolve);
		mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	});
await rpc("initialize", { protocolVersion: "2025-06-18" });

// ─── one API message per step ────────────────────────────────────────────────
async function message(claimed) {
	const step = claimed ?? nextStep();
	if (!step) return; // script exhausted: idle
	const id = `msg_${pid}_${++msgSeq}`;
	ev({ type: "message_start", message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 1, output_tokens: 0 } } });
	if (step.text !== undefined) {
		ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text } });
		ev({ type: "content_block_stop", index: 0 });
		ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
		ev({ type: "message_stop" });
		out({ type: "result", subtype: "success", is_error: false });
		return; // wait for stdin
	}
	const call = step.call ?? step.reject ?? step.lateReject;
	const toolUseId = `toolu_${pid}_${++toolSeq}`;
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolUseId, name: `mcp__lh__${call.name}`, input: {} } });
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } });
	ev({ type: "content_block_stop", index: 0 });
	if (step.reject) {
		// "it moves on by itself": the NEXT step belongs to this process, claimed before anything
		// is written. Claimed after, a loaded runner could let the app kill this process first and
		// the fresh one would take that step (a race the tests must not depend on).
		const following = nextStep();
		// Claude Code's own schema check: answered here, never reaches MCP
		out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "InputValidationError", is_error: true }] } });
		ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } });
		ev({ type: "message_stop" });
		return message(following); // it moves on by itself
	}
	if (step.lateReject) {
		ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } });
		ev({ type: "message_stop" });
		await new Promise((r) => setTimeout(r, call.delayMs ?? 300));
		out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "InputValidationError", is_error: true }] } });
		return message();
	}
	const reply = rpc("tools/call", { name: call.name, arguments: call.args });
	log("mcp-call", { name: call.name });
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } });
	ev({ type: "message_stop" });
	const result = await reply;
	log("mcp-reply", { text: result.result?.content?.[0]?.text, types: (result.result?.content ?? []).map((c) => c.type) });
	out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result.result?.content }] } });
	return message();
}

let inBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	inBuf += chunk;
	let nl;
	while ((nl = inBuf.indexOf("\n")) >= 0) {
		const line = inBuf.slice(0, nl).trim();
		inBuf = inBuf.slice(nl + 1);
		if (!line) continue;
		const msg = JSON.parse(line);
		const content = msg.message.content;
		log("input", { blocks: content.length, types: Array.isArray(content) ? content.map((c) => c.type) : ["text"] });
		void message();
	}
});
process.stdin.on("end", () => {
	mcp.kill();
	process.exit(0);
});
