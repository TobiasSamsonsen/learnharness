import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as net from "node:net";
import {
	calculateCost,
	createAssistantMessageEventStream,
	createProvider,
	getCurrentSystemPrompt,
	getCurrentTools,
	parseStreamingJson,
	parseToolCallArguments,
	toToolDeclaration,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Message,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StopReason,
	type Tool,
	type ToolCall,
	type TranscriptContext,
	validateToolCall,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { SKETCH_LABEL_RE } from "../core/sketch.ts";

/**
 * THE CLAUDE CODE PROVIDER (fork addition, 2026-10-24): model turns run
 * through the locally installed `claude` CLI, so the user's Claude
 * subscription — the CLI's own sign-in — pays for them instead of an API
 * key. The app never sees or stores a credential; Claude Code owns auth.
 *
 * One `claude -p` process lives per conversation (see "the process: live
 * sessions" below for the full lifecycle):
 *   - the replayed system prompt (+ a short transport note) goes in via
 *     --system-prompt-file; Claude Code's own prompt and built-in tools
 *     are off (--tools "", --setting-sources "", --strict-mcp-config);
 *   - the app's tools are declared to the model through a stub MCP server
 *     that BRIDGES each call back to this process and holds it open; the
 *     model's tool_use blocks are handed to pi's agent loop, which runs the
 *     real tools exactly as for every other provider, and the next model
 *     call answers the held call — Claude Code continues its own loop
 *     (cache kept, its own thinking and real tool results in context);
 *   - a process starts from the transcript so far as ONE user message
 *     (stream-json input, so images ride inline as real image blocks) —
 *     Claude Code cannot replay a foreign assistant history natively;
 *   - each API message's raw stream events map 1:1 onto pi's event
 *     protocol (the same mapping pi-ai's anthropic-messages adapter uses).
 *
 * The catalog mirrors pi-ai's Anthropic models (context windows, thinking
 * maps) at ZERO cost — subscription turns are not billed per token; usage
 * counts still flow to the meters.
 */

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
const CLAUDE_CODE_API = "claude-code-cli";
/** Claude Code prefixes MCP tool names with mcp__<server>__. */
const MCP_SERVER = "lh";
const TOOL_PREFIX = `mcp__${MCP_SERVER}__`;

// ─── locating the CLI ────────────────────────────────────────────────────────

/** Common install locations a GUI-launched app's PATH may miss (the
 *  native installer's ~/.local/bin, the legacy ~/.claude/local, Homebrew). */
function fallbackBins(): string[] {
	const home = os.homedir();
	const exe = process.platform === "win32" ? "claude.exe" : "claude";
	return [
		path.join(home, ".local", "bin", exe),
		path.join(home, ".claude", "local", exe),
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
	];
}

/** The CLI on PATH. On Windows the native `claude.exe` wins over an npm
 *  `claude.cmd` shim wherever each sits on PATH (PR #61's ordering): a
 *  shim only runs through the shell. Then the native installer's usual
 *  locations, and a shim only as the last resort. */
function findOnPath(): string | undefined {
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const isFile = (p: string) => fs.existsSync(p) && fs.statSync(p).isFile();
	const first = (names: readonly string[]) => {
		for (const dir of dirs) for (const name of names) if (isFile(path.join(dir, name))) return path.join(dir, name);
		return undefined;
	};
	if (process.platform !== "win32") return first(["claude"]) ?? fallbackBins().find((p) => fs.existsSync(p));
	const shims = (process.env.PATHEXT ?? ".EXE;.CMD")
		.split(";")
		.filter(Boolean)
		.map((ext) => `claude${ext.toLowerCase()}`)
		.filter((name) => name !== "claude.exe");
	return first(["claude.exe"]) ?? fallbackBins().find((p) => fs.existsSync(p)) ?? first(shims);
}

let resolvedBin: { value: string | undefined } | undefined;

/** The `claude` executable, resolved once per process. LH_CLAUDE_CODE=0
 *  turns the provider off; LH_CLAUDE_CODE_BIN pins an explicit path. */
export function claudeCodeBin(): string | undefined {
	if (process.env.LH_CLAUDE_CODE === "0") return undefined;
	const pinned = process.env.LH_CLAUDE_CODE_BIN;
	if (pinned) return fs.existsSync(pinned) ? pinned : undefined;
	if (!resolvedBin) resolvedBin = { value: findOnPath() };
	return resolvedBin.value;
}

/** Is the Claude Code provider usable — the CLI installed and not
 *  switched off? Sign-in is checked by the CLI itself at the first turn
 *  (a signed-out CLI fails that turn with its own "/login" message). */
export function claudeCodeAvailable(): boolean {
	return claudeCodeBin() !== undefined;
}

// ─── the catalog ─────────────────────────────────────────────────────────────

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** pi-ai's Anthropic catalog re-homed under this provider: dated aliases
 *  dropped (the undated id is the same model), costs zeroed. */
export function claudeCodeModels(): Model<Api>[] {
	return anthropicProvider()
		.getModels()
		.filter((m) => !/-\d{8}$/.test(m.id))
		.map((m) => ({
			...m,
			name: `${m.name} (Claude Code)`,
			api: CLAUDE_CODE_API,
			provider: CLAUDE_CODE_PROVIDER_ID,
			baseUrl: "claude-code://local",
			cost: { ...m.cost, ...ZERO_COST },
		}));
}

// ─── request rendering (pure) ────────────────────────────────────────────────

/** An Anthropic-shaped user content block for Claude Code's stream-json input. */
export type ClaudeCodeInputBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface ClaudeCodeRequest {
	systemPrompt: string;
	tools: Tool[];
	content: ClaudeCodeInputBlock[];
}

const TRANSPORT_NOTE = `<harness_transport>
This conversation runs through Claude Code. When a conversation is (re)started, what was said so far may arrive as one transcript in the user message, made of <user>, <assistant> and <tool_result> elements; your own earlier tool calls appear in it as <tool_call> records, their string arguments shown verbatim (unescaped). Those records are history, not a format to write: writing one as text does nothing. Write only the assistant's next message. The tools named in these instructions are available to you with the ${TOOL_PREFIX} prefix (for example, a tool called "plan" is ${TOOL_PREFIX}plan). To use one, call it with your tool-calling ability — never write a <tool_call> element yourself. Each tool's result arrives in a later turn.
</harness_transport>`;

/** One earlier tool call as the transcript records it: a <parameter>
 *  per argument, top-level strings VERBATIM (JSON.stringify would
 *  replay `\\frac` and `\n` escapes, and the model copies what its
 *  "earlier self" wrote — its next native call double-escapes the
 *  LaTeX), anything else as JSON. The same shape salvageTextToolCalls
 *  parses back, should the model imitate a record instead of calling.
 *  Pure. */
export function renderToolCallRecord(call: ToolCall): string {
	const params = Object.entries(call.arguments).map(
		([name, value]) => `<parameter name="${name}">${typeof value === "string" ? value : JSON.stringify(value)}</parameter>\n`,
	);
	return `<tool_call id="${call.id}" name="${call.name}">\n${params.join("")}</tool_call>\n`;
}

/** The two text shapes seen in live sessions: an imitated transcript
 *  record, and the model's own call syntax that the API failed to parse
 *  (it arrives as text under stop_reason tool_use, closing tags often
 *  mismatched). */
const TEXT_CALLS = [
	// either opener with either closer: live sessions mix them (a record's
	// <tool_call …> closed by the model's own </invoke>)
	/<(?:tool_call|invoke)\b[^>]*?\bname="([^"]+)"[^>]*>([\s\S]*?)<\/(?:tool_call|invoke)>/g,
];
const TEXT_PARAM = /<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g;
/** Wrapper debris left once the calls inside it are lifted out. */
const CALL_DEBRIS = /<\/?(?:tool_call|invoke|function_calls)\b[^>]*>/g;
/** Where a text-written call begins: streaming stops showing text here. */
const CALL_START = /<(?:tool_call|invoke|function_calls)\b/;
const CALL_TOKENS = ["<tool_call", "<invoke", "<function_calls"];

/** How much of a streaming text block may be shown: everything before a
 *  text-written call, minus a trailing fragment that could be the start
 *  of one ("<inv"). Pure. */
export function visibleStreamText(text: string): string {
	const start = text.search(CALL_START);
	if (start >= 0) return text.slice(0, start);
	const lt = text.lastIndexOf("<");
	if (lt >= 0 && CALL_TOKENS.some((t) => t.startsWith(text.slice(lt)))) return text.slice(0, lt);
	return text;
}

/**
 * The fallback for a tool call that arrived as TEXT (see TEXT_CALLS):
 * each element naming a real tool becomes a real call, its parameters
 * typed by the tool's schema (string properties stay raw, the rest
 * parse as JSON). Returns the text with those elements — and, once any
 * was lifted, the wrapper debris around them — removed. Elements naming
 * unknown tools stay as text. Pure.
 */
export function salvageTextToolCalls(text: string, tools: readonly Tool[]): { text: string; calls: ToolCall[] } {
	const calls: ToolCall[] = [];
	const lift = (whole: string, rawName: string, body: string) => {
		const name = rawName.startsWith(TOOL_PREFIX) ? rawName.slice(TOOL_PREFIX.length) : rawName;
		const tool = tools.find((t) => t.name === name);
		if (!tool) return whole;
		const props = ((tool.parameters as { properties?: Record<string, { type?: unknown }> }).properties ?? {});
		const args: Record<string, unknown> = {};
		for (const [, key, raw] of body.matchAll(TEXT_PARAM)) {
			// plain strings stay raw ("5" must not become 5); anything else
			// (arrays, objects, numbers, literal-union enums) tries JSON and
			// falls back to the raw text — tool validation judges the result
			if (props[key!]?.type === "string") args[key!] = raw;
			else {
				try {
					args[key!] = JSON.parse(raw!);
				} catch {
					args[key!] = raw;
				}
			}
		}
		calls.push({ type: "toolCall", id: `toolu_cc_${randomUUID().replace(/-/g, "").slice(0, 20)}`, name, arguments: args as ToolCall["arguments"] });
		return "";
	};
	let rest = TEXT_CALLS.reduce((acc, pattern) => acc.replace(pattern, lift), text);
	if (calls.length > 0) rest = rest.replace(CALL_DEBRIS, "");
	return { text: rest.trim(), calls };
}

/** Render a normalized pi transcript into one Claude Code request: the
 *  replayed system prompt + tool set, and the history as a single
 *  user message (text runs merged, images inline). Pure. */
export function renderClaudeCodeRequest(context: TranscriptContext): ClaudeCodeRequest {
	const prompt = getCurrentSystemPrompt(context.messages);
	const content: ClaudeCodeInputBlock[] = [];
	const text = (s: string) => {
		const last = content[content.length - 1];
		if (last?.type === "text") last.text += s;
		else content.push({ type: "text", text: s });
	};
	const image = (data: string, mimeType: string) =>
		content.push({ type: "image", source: { type: "base64", media_type: mimeType, data } });

	text("<transcript>\n");
	for (const message of context.messages as Message[]) {
		if (message.role === "system") continue; // replayed into the system prompt above
		if (message.role === "user") {
			text("<user>\n");
			if (typeof message.content === "string") text(message.content);
			else for (const block of message.content) block.type === "text" ? text(block.text) : image(block.data, block.mimeType);
			text("\n</user>\n");
		} else if (message.role === "assistant") {
			text("<assistant>\n");
			for (const block of message.content) {
				if (block.type === "text") text(`${block.text}\n`);
				else if (block.type === "toolCall") text(renderToolCallRecord(block));
				// agent reasoning stays out: it belongs to the turn that produced it
			}
			text("</assistant>\n");
		} else if (message.role === "toolResult") {
			text(`<tool_result tool_call_id="${message.toolCallId}" name="${message.toolName}"${message.isError ? ' error="true"' : ""}>\n`);
			for (const block of message.content) block.type === "text" ? text(block.text) : image(block.data, block.mimeType);
			text("\n</tool_result>\n");
		}
	}
	// Recency matters: the closing line restates the one rule the
	// transcript's own records tempt the model to break.
	text(
		"</transcript>\n\nWrite the assistant's next message. To use a tool, make a real tool call — a <tool_call> written as text does nothing.",
	);
	return {
		systemPrompt: prompt ? `${prompt}\n\n${TRANSPORT_NOTE}` : TRANSPORT_NOTE,
		tools: getCurrentTools(context.messages).map(toToolDeclaration),
		content,
	};
}

/** pi thinking level → Claude Code --effort (the anthropic-messages
 *  adapter's mapping: the model's own map first, then the plain ladder).
 *  No level (pi's "off") sends no flag — Claude Code's default applies. */
export function claudeCodeEffort(model: Model<Api>, level: SimpleStreamOptions["reasoning"]): string | undefined {
	if (!level) return undefined;
	const mapped = model.thinkingLevelMap?.[level];
	if (typeof mapped === "string") return mapped;
	return level === "minimal" ? "low" : level;
}

// ─── response translation ────────────────────────────────────────────────────

function mapStopReason(raw: string): { stopReason: StopReason; errorMessage?: string } {
	switch (raw) {
		case "tool_use":
			return { stopReason: "toolUse" };
		case "max_tokens":
		case "model_context_window_exceeded":
			return { stopReason: "length" };
		case "refusal":
			return { stopReason: "error", errorMessage: "The model declined to respond (refusal)" };
		default:
			return { stopReason: "stop" };
	}
}

type Block = (AssistantMessage["content"][number]) & { index?: number; partialJson?: string };

/**
 * Claude Code's stream-json output → pi events, for the FIRST API message
 * of the run (top-level only — subagent traffic carries a
 * parent_tool_use_id). Feed parsed lines in order; `finished` flips at
 * that message's message_stop, after `done` (or `error`) was pushed.
 */
export class ClaudeCodeTranslator {
	readonly output: AssistantMessage;
	finished = false;
	private started = false;
	/** The last error-ish text Claude Code printed (a signed-out CLI, a
	 *  rate limit) — what a run that never completes a message reports. */
	private lastErrorText: string | undefined;
	/** Calls lifted out of text blocks, pending message end (salvage). */
	private readonly textCalls: ToolCall[] = [];

	constructor(
		private readonly stream: AssistantMessageEventStream,
		private readonly model: Model<Api>,
		/** The request's tools — what salvageTextToolCalls may recover. */
		private readonly tools: readonly Tool[] = [],
	) {
		this.output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending",
			timestamp: Date.now(),
		};
	}

	private get blocks(): Block[] {
		return this.output.content as Block[];
	}

	private updateUsage(usage: Record<string, unknown> | undefined): void {
		if (!usage) return;
		const u = this.output.usage;
		const num = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : undefined);
		u.input = num("input_tokens") ?? u.input;
		u.output = num("output_tokens") ?? u.output;
		u.cacheRead = num("cache_read_input_tokens") ?? u.cacheRead;
		u.cacheWrite = num("cache_creation_input_tokens") ?? u.cacheWrite;
		const thinking = (usage.output_tokens_details as { thinking_tokens?: number } | undefined)?.thinking_tokens;
		if (typeof thinking === "number") u.reasoning = thinking;
		u.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
		calculateCost(this.model, u);
	}

	/** One parsed stream-json line. */
	push(line: Record<string, unknown>): void {
		if (this.finished) return;
		if (line.type === "result") {
			if (line.is_error && line.result) this.lastErrorText = String(line.result);
			return;
		}
		if (line.type === "assistant") {
			// a CLI-synthesized error reply ("Not logged in · Please run /login")
			if (line.error) {
				const content = (line.message as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [];
				const text = content.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
				if (text) this.lastErrorText = text;
			}
			return;
		}
		if (line.type !== "stream_event" || line.parent_tool_use_id) return;
		const event = line.event as Record<string, any>;
		const { stream, output } = this;
		const find = (index: number) => this.blocks.findIndex((b) => b.index === index);

		if (event.type === "message_start") {
			output.responseId = event.message?.id;
			if (event.message?.model && event.message.model !== this.model.id) output.responseModel = event.message.model;
			this.updateUsage(event.message?.usage);
			if (!this.started) {
				this.started = true;
				stream.push({ type: "start", partial: output });
			}
		} else if (event.type === "content_block_start") {
			const cb = event.content_block ?? {};
			if (cb.type === "text") {
				this.blocks.push({ type: "text", text: cb.text ?? "", index: event.index });
				stream.push({ type: "text_start", contentIndex: this.blocks.length - 1, partial: output });
			} else if (cb.type === "tool_use") {
				const name = String(cb.name ?? "");
				this.blocks.push({
					type: "toolCall",
					id: cb.id,
					name: name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name,
					arguments: cb.input ?? {},
					partialJson: "",
					index: event.index,
				});
				stream.push({ type: "toolcall_start", contentIndex: this.blocks.length - 1, partial: output });
			}
			// thinking blocks open lazily on their first non-empty delta:
			// Claude Code often streams only a signature, no readable text
		} else if (event.type === "content_block_delta") {
			const delta = event.delta ?? {};
			let i = find(event.index);
			if (delta.type === "thinking_delta" && delta.thinking) {
				if (i < 0) {
					this.blocks.push({ type: "thinking", thinking: "", index: event.index });
					i = this.blocks.length - 1;
					stream.push({ type: "thinking_start", contentIndex: i, partial: output });
				}
				const block = this.blocks[i]!;
				if (block.type === "thinking") {
					block.thinking += delta.thinking;
					stream.push({ type: "thinking_delta", contentIndex: i, delta: delta.thinking, partial: output });
				}
			} else if (i >= 0) {
				const block = this.blocks[i]!;
				if (delta.type === "text_delta" && block.type === "text") {
					// stream only what is safe to show: a text-written call
					// never flashes on screen (it is lifted out at block end)
					const before = visibleStreamText(block.text).length;
					block.text += delta.text;
					const shown = visibleStreamText(block.text);
					if (shown.length > before)
						stream.push({ type: "text_delta", contentIndex: i, delta: shown.slice(before), partial: output });
				} else if (delta.type === "input_json_delta" && block.type === "toolCall") {
					block.partialJson = (block.partialJson ?? "") + delta.partial_json;
					block.arguments = parseStreamingJson(block.partialJson);
					stream.push({ type: "toolcall_delta", contentIndex: i, delta: delta.partial_json, partial: output });
				}
			}
		} else if (event.type === "content_block_stop") {
			const i = find(event.index);
			if (i < 0) return;
			const block = this.blocks[i]!;
			delete block.index;
			if (block.type === "text") {
				// lift text-written calls out now, so text_end and the final
				// message carry only the prose; the calls wait for message end
				if (CALL_START.test(block.text)) {
					const { text, calls } = salvageTextToolCalls(block.text, this.tools);
					block.text = text;
					this.textCalls.push(...calls);
				}
				stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: output });
			}
			else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: i, content: block.thinking, partial: output });
			else if (block.type === "toolCall") {
				Object.assign(block, parseToolCallArguments(block.partialJson));
				delete block.partialJson;
				stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block as ToolCall, partial: output });
			}
		} else if (event.type === "message_delta") {
			if (event.delta?.stop_reason) {
				output.rawStopReason = event.delta.stop_reason;
				const mapped = mapStopReason(event.delta.stop_reason);
				output.stopReason = mapped.stopReason;
				if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
			}
			this.updateUsage(event.usage);
		} else if (event.type === "message_stop") {
			if (output.stopReason === "pending") output.stopReason = "stop";
			if (output.stopReason === "error") this.fail(output.errorMessage ?? "Claude Code turn failed");
			else {
				this.salvage();
				this.finished = true;
				stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
				stream.end();
			}
		}
	}

	/** A turn with no native call but calls WRITTEN as text (already lifted
	 *  out of the prose at their block's end): they become real toolCall
	 *  blocks, announced like streamed ones. A turn that also called
	 *  natively keeps only the native calls — the text copies were noise. */
	private salvage(): void {
		const recovered = this.textCalls.splice(0);
		if (recovered.length === 0 || this.blocks.some((b) => b.type === "toolCall")) return;
		for (const call of recovered) {
			this.blocks.push(call);
			const i = this.blocks.length - 1;
			this.stream.push({ type: "toolcall_start", contentIndex: i, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex: i, toolCall: call, partial: this.output });
		}
		this.output.stopReason = "toolUse";
	}

	/** End the turn as failed (or aborted). Idempotent. */
	fail(message: string, reason: "error" | "aborted" = "error"): void {
		if (this.finished) return;
		this.finished = true;
		for (const block of this.blocks) {
			delete block.index;
			delete block.partialJson;
		}
		this.output.stopReason = reason;
		this.output.errorMessage = this.lastErrorText ? `${message}: ${this.lastErrorText}` : message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}
}

// ─── the process: live sessions ──────────────────────────────────────────────
//
// USAGE (fork, 2026-10-24 — measured through a logging proxy): a fresh
// `claude -p` per model call wrote the WHOLE transcript to the prompt
// cache on every call and never read it back (Claude Code ends each
// request with an environment message carrying the cache breakpoint, so a
// grown transcript is never a prefix of the last request), and a stub that
// answered tool calls itself let Claude Code fire follow-up requests
// before the kill landed. Now ONE Claude Code process lives per
// conversation and keeps the real history itself:
//
//   - its tool calls go to a BRIDGE: the stub MCP server forwards each
//     tools/call to this process over loopback TCP and waits; the app's
//     agent loop runs the real tool, and the next model call hands the
//     result back through the waiting call — Claude Code continues its own
//     loop, with its own cache breakpoints (each call reads the history
//     from cache and writes only the new part);
//   - a new learner message is written to the still-open stdin;
//   - anything else (the app's history no longer extends what the process
//     has seen: compaction, a steer, a salvaged text call, a changed system
//     prompt, a restart) starts a fresh process from the replayed
//     transcript, which then lives on.
//
// A session is reused only for an exact continuation (message
// fingerprints), so a mismatch costs one cache write, never a wrong
// conversation.

/** The bridge stub (newline-delimited JSON-RPC over stdio): declares the
 *  tools and forwards every tools/call to the app, answering with the
 *  app's reply. Exits with its parent or the app. */
const MCP_STUB = `import { readFileSync } from "node:fs";
import net from "node:net";
const tools = JSON.parse(readFileSync(process.argv[2], "utf8"));
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
const bridge = net.connect(Number(process.env.LH_BRIDGE_PORT), "127.0.0.1", () => {
	bridge.write(JSON.stringify({ token: process.env.LH_BRIDGE_TOKEN }) + "\\n");
});
bridge.setEncoding("utf8");
let back = "";
bridge.on("data", (chunk) => {
	back += chunk;
	let nl;
	while ((nl = back.indexOf("\\n")) >= 0) {
		const line = back.slice(0, nl);
		back = back.slice(nl + 1);
		if (line) process.stdout.write(line + "\\n");
	}
});
// Losing the app must stop the conversation, not fail the held tool call:
// a failed call would let the model carry on by itself, on the user's plan.
const orphaned = () => {
	try { process.kill(process.ppid); } catch {}
	process.exit(0);
};
bridge.on("error", orphaned);
bridge.on("close", orphaned);
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let nl;
	while ((nl = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (!line) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		if (msg.id === undefined) continue;
		if (msg.method === "initialize")
			send({ id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "learnharness", version: "1" } } });
		else if (msg.method === "tools/list") send({ id: msg.id, result: { tools } });
		else if (msg.method === "tools/call") bridge.write(line + "\\n");
		else send({ id: msg.id, error: { code: -32601, message: "method not found" } });
	}
});
`;

const WORK_ROOT = path.join(os.tmpdir(), "learnharness-claude-code");
/** One stable working directory: Claude Code's environment message names
 *  it, and a stable request keeps the cache stable. */
const CWD = path.join(WORK_ROOT, "cwd");
/** Live processes kept at most (each holds a model conversation). */
const DEFAULT_MAX_SESSIONS = 6;

/** LH_CLAUDE_CODE_MAX_SESSIONS (Android plan M6): a positive integer; an
 *  unset, empty, non-integer or < 1 value is the default. Pure, for tests. */
export function parseMaxSessions(value: string | undefined): number {
	const text = value?.trim() ?? "";
	if (!/^[0-9]+$/.test(text)) return DEFAULT_MAX_SESSIONS;
	const n = Number(text);
	return Number.isSafeInteger(n) && n >= 1 ? n : DEFAULT_MAX_SESSIONS;
}
/** An idle session dies after this — inside the 1-hour prompt cache. */
const IDLE_MS = 40 * 60_000;

function stubPath(): string {
	const file = path.join(WORK_ROOT, "mcp-bridge-stub.mjs");
	fs.mkdirSync(WORK_ROOT, { recursive: true });
	if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== MCP_STUB) fs.writeFileSync(file, MCP_STUB);
	return file;
}

/** The child's env: the app's own Anthropic credentials stripped, so the
 *  CLI bills the subscription and not a key the user saved for the
 *  plain Anthropic provider; nested-session markers dropped. A held tool
 *  call may wait for a learner's answer for a long time. */
function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, MCP_TOOL_TIMEOUT: String(24 * 60 * 60_000) };
	for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete env[name];
	return env;
}

function spawnClaude(bin: string, args: string[], cwd: string): ChildProcess {
	// npm-style .cmd shims only run through the shell on Windows; quote
	// every arg so the empty --tools/--setting-sources values survive.
	const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
	return spawn(shell ? `"${bin}"` : bin, shell ? args.map((a) => `"${a}"`) : args, {
		cwd,
		env: childEnv(),
		shell,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
}

// ─── fingerprints (pure) ─────────────────────────────────────────────────────

/** Content blocks, fingerprinted. A SKETCH page is its label whether it
 *  rides as an image or as a text stub (elided, out of the window, or
 *  unreadable): the label hashes alone and the image after it is skipped —
 *  so a sketch changing form never breaks a live session's prefix (the
 *  process already holds the image it was sent; the stub only matters to a
 *  fresh replay). */
function fingerprintBlocks(content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>): unknown[] {
	const out: unknown[] = [];
	let afterLabel = false;
	for (const b of content) {
		if (b.type === "text") {
			const label = SKETCH_LABEL_RE.exec(b.text ?? "");
			if (label) {
				out.push(["sk", label[1], label[2], label[3]]);
				afterLabel = true;
				continue;
			}
			out.push(b.text);
			afterLabel = false;
		} else {
			if (afterLabel) {
				afterLabel = false;
				continue;
			}
			out.push({ img: createHash("sha1").update(b.data ?? "").digest("hex"), t: b.mimeType });
		}
	}
	return out;
}

/** A message's identity for continuation checks: what the model saw of it. */
export function messageFingerprint(m: Message): string {
	let shape: unknown;
	if (m.role === "user") {
		shape = ["u", typeof m.content === "string" ? m.content : fingerprintBlocks(m.content)];
	} else if (m.role === "assistant") {
		shape = ["a", m.content.map((b) => (b.type === "text" ? b.text : b.type === "thinking" ? ["th", b.thinking] : ["tc", b.id, b.name, b.arguments]))];
	} else if (m.role === "toolResult") {
		shape = ["r", m.toolCallId, m.isError, fingerprintBlocks(m.content)];
	} else {
		shape = ["s"];
	}
	return createHash("sha1").update(JSON.stringify(shape)).digest("hex");
}

/** Is `prefix` a prefix of `all`? Pure. */
export function isPrefixOf(prefix: readonly string[], all: readonly string[]): boolean {
	return prefix.length <= all.length && prefix.every((f, i) => all[i] === f);
}

/** How a live session continues with these new messages, or null when it
 *  cannot (start fresh). Pure.
 *   awaiting-tools: exactly one result per pending tool call, nothing else
 *   idle:           only learner messages */
export function continuation(
	state: "awaiting-tools" | "idle",
	pendingToolIds: readonly string[],
	delta: readonly Message[],
): "results" | "user" | null {
	if (delta.length === 0) return null;
	if (state === "awaiting-tools") {
		const ids = delta.map((m) => (m.role === "toolResult" ? m.toolCallId : null));
		const ok =
			ids.every((id) => id !== null && pendingToolIds.includes(id)) &&
			new Set(ids).size === pendingToolIds.length &&
			ids.length === pendingToolIds.length;
		return ok ? "results" : null;
	}
	return delta.every((m) => m.role === "user") ? "user" : null;
}

/** A tool result as the MCP reply Claude Code is waiting for. Pure. */
export function mcpResult(m: Extract<Message, { role: "toolResult" }>): Record<string, unknown> {
	const content = m.content.map((b) =>
		b.type === "text" ? { type: "text", text: b.text } : { type: "image", data: b.data, mimeType: b.mimeType },
	);
	return { content: content.length ? content : [{ type: "text", text: "" }], ...(m.isError ? { isError: true } : {}) };
}

/** A learner message as Claude Code's stream-json input content. Pure. */
function userContent(messages: readonly Message[]): ClaudeCodeInputBlock[] {
	const out: ClaudeCodeInputBlock[] = [];
	for (const m of messages) {
		if (m.role !== "user") continue;
		if (typeof m.content === "string") out.push({ type: "text", text: m.content });
		else
			for (const b of m.content)
				out.push(b.type === "text" ? { type: "text", text: b.text } : { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } });
	}
	return out;
}

// ─── the bridge ──────────────────────────────────────────────────────────────

interface HeldCall {
	rpcId: unknown;
	name: string;
	args: unknown;
	/** The tool_use it answers, once matched. */
	toolUseId?: string;
}

interface LiveSession {
	key: string;
	token: string;
	child: ChildProcess;
	socket: net.Socket | null;
	state: "streaming" | "awaiting-tools" | "idle" | "dead";
	/** Fingerprints of every message this process has seen, its own replies included. */
	fed: string[];
	/** The last reply's tool calls, waiting for their results. */
	toolUses: ToolCall[];
	held: HeldCall[];
	/** This round's tool uses already answered. */
	answered: Set<string>;
	/** A reply ended the run (no tool calls): Claude Code's closing
	 *  `result` line for it is still to come, and must not be read as the
	 *  NEXT call's failure. */
	resultOwed: boolean;
	/** Results known before Claude Code asked for them (toolUseId → reply). */
	ready: Map<string, Record<string, unknown>>;
	/** The tools declared to this process (constant: part of the session key). */
	tools: Tool[];
	/** This message's tool uses Claude Code already answered ITSELF (an
	 *  argument its own schema check rejected, an unknown tool) — they never
	 *  reach the bridge, so the process must not wait on them. */
	selfAnswered: Set<string>;
	translator: ClaudeCodeTranslator | null;
	endCall: (() => void) | null;
	/** While a continuation call is bound: start it over on a fresh process
	 *  (Claude Code moved on without one of our results). */
	onLost: (() => void) | null;
	lastUsed: number;
	stderr: string;
	dir: string;
}

const STATE_KEY = Symbol.for("lh.claudeCodeLive");
interface LiveState {
	sessions: Map<string, LiveSession>;
	byToken: Map<string, LiveSession>;
	bridge: Promise<number> | null;
	sweeper: ReturnType<typeof setInterval> | null;
}
function live(): LiveState {
	const g = globalThis as Record<symbol, LiveState | undefined>;
	g[STATE_KEY] ??= { sessions: new Map(), byToken: new Map(), bridge: null, sweeper: null };
	return g[STATE_KEY];
}

/** Canonical JSON (sorted keys) — tool arguments compared structurally. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value as object)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

function reply(s: LiveSession, call: HeldCall, result: Record<string, unknown>): void {
	s.socket?.write(JSON.stringify({ jsonrpc: "2.0", id: call.rpcId, result }) + "\n");
	s.held = s.held.filter((h) => h !== call);
	if (call.toolUseId) s.answered.add(call.toolUseId);
}

/** Match each unmatched held call to a tool use of this round (same name
 *  and arguments, else the first free one with that name), and answer the
 *  ones whose result is already in. A call can arrive (socket) BEFORE its
 *  reply's end (stdout) — it waits unmatched until settle() knows the
 *  reply's tool uses, then matches here. */
function matchHeld(s: LiveSession): void {
	for (const call of s.held) {
		if (call.toolUseId) continue;
		const taken = new Set([...s.answered, ...s.held.map((h) => h.toolUseId).filter((id): id is string => !!id)]);
		const free = s.toolUses.filter((t) => !taken.has(t.id) && t.name === call.name);
		call.toolUseId = (free.find((t) => canonical(t.arguments) === canonical(call.args)) ?? free[0])?.id;
	}
	for (const call of [...s.held]) {
		const result = call.toolUseId ? s.ready.get(call.toolUseId) : undefined;
		if (result) {
			s.ready.delete(call.toolUseId!);
			reply(s, call, result);
		}
	}
}

function onToolCall(s: LiveSession, rpc: { id: unknown; params?: { name?: string; arguments?: unknown } }): void {
	s.held.push({ rpcId: rpc.id, name: rpc.params?.name ?? "", args: rpc.params?.arguments ?? {} });
	matchHeld(s);
}

function ensureBridge(): Promise<number> {
	const st = live();
	st.bridge ??= new Promise<number>((resolve, reject) => {
		const server = net.createServer((socket) => {
			socket.setEncoding("utf8");
			let buf = "";
			let session: LiveSession | undefined;
			socket.on("error", () => {});
			socket.on("data", (chunk: string) => {
				buf += chunk;
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) continue;
					let msg: Record<string, unknown>;
					try {
						msg = JSON.parse(line);
					} catch {
						continue;
					}
					if (!session) {
						session = st.byToken.get(String(msg.token ?? ""));
						if (!session) return socket.destroy(); // not ours
						session.socket = socket;
						continue;
					}
					if (msg.method === "tools/call") onToolCall(session, msg as never);
				}
			});
		});
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
		server.unref();
	});
	// the server going down takes its live processes with it (a hard kill
	// skips this; the bridge stubs then end their Claude Code themselves)
	if (!st.sweeper) {
		process.once("exit", () => [...live().sessions.values()].forEach(kill));
		// folders a hard-killed server left behind
		const sessionsDir = path.join(WORK_ROOT, "sessions");
		for (const name of fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []) {
			fs.rm(path.join(sessionsDir, name), { recursive: true, force: true }, () => {});
		}
	}
	st.sweeper ??= setInterval(() => {
		for (const s of live().sessions.values()) if (s.state !== "streaming" && Date.now() - s.lastUsed > IDLE_MS) kill(s);
	}, 60_000);
	st.sweeper.unref?.();
	return st.bridge;
}

function kill(s: LiveSession): void {
	if (s.state === "dead") return;
	s.state = "dead";
	s.translator = null; // nothing from a dying process reaches a turn
	const st = live();
	if (st.sessions.get(s.key) === s) st.sessions.delete(s.key);
	st.byToken.delete(s.token);
	s.socket?.destroy();
	if (s.child.exitCode === null && !s.child.killed) s.child.kill();
	fs.rm(s.dir, { recursive: true, force: true }, () => {});
}

/** End every live Claude Code process (tests; a server that shuts down
 *  without exiting). Idle sessions otherwise live on for IDLE_MS. */
export function closeClaudeCodeSessions(): void {
	for (const s of [...live().sessions.values()]) kill(s);
}

/** Keep at most LH_CLAUDE_CODE_MAX_SESSIONS: the least recently used non-streaming go. */
function evict(): void {
	const st = live();
	const max = parseMaxSessions(process.env.LH_CLAUDE_CODE_MAX_SESSIONS);
	const idle = [...st.sessions.values()].filter((s) => s.state !== "streaming").sort((a, b) => a.lastUsed - b.lastUsed);
	while (st.sessions.size >= max && idle.length) kill(idle.shift()!);
}

/** Would Claude Code itself accept this call — a declared tool, with
 *  arguments its schema check passes? (pi's own validation, which also
 *  converts types — the self-answered guard below catches the rest.) Pure. */
export function cliWouldRunCall(tools: readonly Tool[], call: ToolCall): boolean {
	try {
		validateToolCall(tools as Tool[], call);
		return true;
	} catch {
		return false;
	}
}

/** The tool_use ids a top-level stream-json `user` line answers. Pure. */
export function answeredToolUseIds(line: Record<string, unknown>): string[] {
	if (line.type !== "user" || line.parent_tool_use_id) return [];
	const content = (line.message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	return content.flatMap((b: { type?: unknown; tool_use_id?: unknown }) =>
		b?.type === "tool_result" && typeof b.tool_use_id === "string" ? [b.tool_use_id] : [],
	);
}

/** Claude Code answered tool calls by itself (PR #61's guard). For the
 *  message still streaming: remember them — settle starts over. For the
 *  previous round (it moved on without our results): the process is no
 *  longer the conversation the app is having — a bound continuation
 *  starts over on a fresh process, a waiting session just ends. */
function selfAnswered(s: LiveSession, ids: readonly string[]): void {
	const previousRound = ids.some((id) => s.toolUses.some((t) => t.id === id));
	if (!previousRound && s.translator) {
		for (const id of ids) s.selfAnswered.add(id);
		return;
	}
	const restart = s.onLost;
	debug(`lost: Claude Code answered ${ids.length} call(s) itself${restart ? " → fresh process" : ""}`);
	s.endCall?.();
	s.endCall = null;
	s.onLost = null;
	kill(s);
	restart?.();
}

/** One reply finished: record it and set what the session waits for. */
function settle(s: LiveSession, output: AssistantMessage): void {
	s.translator = null;
	s.endCall?.();
	s.endCall = null;
	s.onLost = null;
	s.lastUsed = Date.now();
	const calls = output.content.filter((b): b is ToolCall => b.type === "toolCall");
	// a call recovered from text is not in Claude Code's own history
	if (output.stopReason === "error" || output.stopReason === "aborted" || calls.some((c) => c.id.startsWith("toolu_cc_"))) {
		kill(s);
		return;
	}
	// a call Claude Code rejects itself never reaches the bridge: a process
	// waiting on it would hang the next turn (PR #61) — the app's loop runs
	// it (and reports the error) and the next call starts fresh
	const rejected = calls.filter((c) => s.selfAnswered.has(c.id) || !cliWouldRunCall(s.tools, c));
	s.selfAnswered.clear();
	if (rejected.length > 0) {
		debug(`fresh next: ${rejected.map((c) => c.name).join(", ")} rejected by Claude Code itself`);
		kill(s);
		return;
	}
	s.fed.push(messageFingerprint(output));
	s.toolUses = calls;
	s.answered = new Set();
	s.ready.clear();
	s.state = calls.length > 0 ? "awaiting-tools" : "idle";
	if (calls.length === 0) s.resultOwed = true;
	matchHeld(s); // calls that arrived before this reply's end
}

function startSession(
	key: string,
	bin: string,
	model: Model<Api>,
	request: ClaudeCodeRequest,
	effort: string | undefined,
	port: number,
): LiveSession {
	evict();
	const token = randomUUID();
	const dir = path.join(WORK_ROOT, "sessions", token);
	fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(CWD, { recursive: true });
	const systemFile = path.join(dir, "system-prompt.md");
	fs.writeFileSync(systemFile, request.systemPrompt);
	const args = [
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--no-session-persistence",
		"--tools", "",
		"--setting-sources", "",
		"--strict-mcp-config",
		"--disable-slash-commands",
		"--system-prompt-file", systemFile,
		"--model", model.id,
	];
	if (effort) args.push("--effort", effort);
	if (request.tools.length > 0) {
		const toolsFile = path.join(dir, "tools.json");
		fs.writeFileSync(
			toolsFile,
			JSON.stringify(request.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }))),
		);
		const mcpFile = path.join(dir, "mcp.json");
		fs.writeFileSync(
			mcpFile,
			JSON.stringify({
				mcpServers: {
					[MCP_SERVER]: {
						command: process.execPath,
						args: [stubPath(), toolsFile],
						// process.execPath is Electron in the packaged app
						env: { ELECTRON_RUN_AS_NODE: "1", LH_BRIDGE_PORT: String(port), LH_BRIDGE_TOKEN: token },
					},
				},
			}),
		);
		args.push("--mcp-config", mcpFile, "--allowedTools", `mcp__${MCP_SERVER}`);
	}
	const child = spawnClaude(bin, args, CWD);
	const s: LiveSession = {
		key,
		token,
		child,
		socket: null,
		state: "streaming",
		fed: [],
		toolUses: [],
		held: [],
		answered: new Set(),
		resultOwed: false,
		ready: new Map(),
		tools: request.tools,
		selfAnswered: new Set(),
		translator: null,
		endCall: null,
		onLost: null,
		lastUsed: Date.now(),
		stderr: "",
		dir,
	};
	const st = live();
	st.sessions.set(key, s);
	st.byToken.set(token, s);

	let buffer = "";
	child.stdout!.setEncoding("utf8");
	child.stdout!.on("data", (chunk: string) => {
		buffer += chunk;
		let nl: number;
		while (s.state !== "dead" && (nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // non-JSON noise (a CLI banner) is not part of the protocol
			}
			if (parsed.type === "rate_limit_event") recordPlanUsage(parsed.rate_limit_info);
			const own = answeredToolUseIds(parsed).filter((id) => !s.answered.has(id));
			if (own.length > 0) {
				selfAnswered(s, own);
				continue;
			}
			if (parsed.type === "result" && s.resultOwed) {
				s.resultOwed = false; // the closing line of the run that already settled
				continue;
			}
			const t = s.translator;
			if (!t) continue;
			t.push(parsed);
			if (t.finished) settle(s, t.output);
			// a run that ended without completing a message (an API error)
			else if (parsed.type === "result") {
				t.fail("Claude Code ended the turn without a reply");
				settle(s, t.output);
			}
		}
	});
	child.stderr!.setEncoding("utf8");
	child.stderr!.on("data", (chunk: string) => {
		s.stderr = (s.stderr + chunk).slice(-4000);
	});
	const died = (why: string) => {
		const t = s.translator;
		if (t && !t.finished) t.fail(why);
		s.endCall?.();
		kill(s);
	};
	child.on("error", (err) => died(`Could not start Claude Code (${bin}): ${err.message}`));
	child.on("close", (code) => {
		const tail = s.stderr.trim().split("\n").slice(-3).join(" ").trim();
		died(`Claude Code exited (code ${code ?? "?"}) before finishing the turn${tail ? ` — ${tail}` : ""}`);
	});
	child.stdin!.on("error", () => {}); // a CLI that dies early closes the pipe; close reports it
	return s;
}

function writeUser(s: LiveSession, content: ClaudeCodeInputBlock[]): void {
	s.child.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

/** Bind one model call to a session: its translator, abort, and end. */
function bindCall(s: LiveSession, translator: ClaudeCodeTranslator, signal: AbortSignal | undefined, onLost: (() => void) | null = null): void {
	s.state = "streaming";
	s.translator = translator;
	s.onLost = onLost;
	s.lastUsed = Date.now();
	const onAbort = () => {
		translator.fail("Request was aborted", "aborted");
		kill(s); // an in-flight request only stops with its process
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	s.endCall = () => signal?.removeEventListener("abort", onAbort);
}

/** The session identity: conversation, prompt, tools, model, effort, and
 *  the conversation's first message (background jobs share a chat id). */
function sessionKey(sessionId: string | undefined, request: ClaudeCodeRequest, modelId: string, effort: string | undefined, first: string | undefined): string {
	return createHash("sha1")
		.update(JSON.stringify([sessionId ?? "", request.systemPrompt, canonical(request.tools), modelId, effort ?? "", first ?? ""]))
		.digest("hex");
}

/** LH_CLAUDE_CODE_DEBUG=1: one line per model call — live or fresh, and why. */
function debug(line: string): void {
	if (process.env.LH_CLAUDE_CODE_DEBUG === "1") console.info(`[claude-code] ${line}`);
}

/** The provider's stream function (exported for the fake-CLI tests). */
export function streamClaudeCode(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const bin = claudeCodeBin();
	const request = renderClaudeCodeRequest(context);
	const translator = new ClaudeCodeTranslator(stream, model, request.tools);
	if (!bin) {
		translator.fail("Claude Code CLI not found — install it and run `claude` once to sign in, or set LH_CLAUDE_CODE_BIN");
		return stream;
	}
	if (options?.signal?.aborted) {
		translator.fail("Request was aborted", "aborted");
		return stream;
	}
	const messages = (context.messages as Message[]).filter((m) => m.role !== "system");
	const fps = messages.map(messageFingerprint);
	const effort = claudeCodeEffort(model, options?.reasoning);
	const key = sessionKey(options?.sessionId, request, model.id, effort, fps[0]);

	void ensureBridge()
		.then((port) => {
			if (options?.signal?.aborted) return translator.fail("Request was aborted", "aborted");
			/** Start this call on a fresh process from the replayed transcript. */
			const fresh = () => {
				const s = startSession(key, bin, model, request, effort, port);
				bindCall(s, translator, options?.signal);
				s.fed = [...fps];
				writeUser(s, request.content);
			};
			const existing = live().sessions.get(key);
			if (existing && (existing.state === "awaiting-tools" || existing.state === "idle") && isPrefixOf(existing.fed, fps)) {
				const delta = messages.slice(existing.fed.length);
				const how = continuation(existing.state, existing.toolUses.map((t) => t.id), delta);
				if (how === "results") {
					debug(`live: ${delta.length} tool result(s) → ${model.id}`);
					bindCall(existing, translator, options?.signal, fresh);
					existing.fed = [...fps];
					// results wait in `ready` until Claude Code's call for them is matched
					for (const m of delta as Extract<Message, { role: "toolResult" }>[]) existing.ready.set(m.toolCallId, mcpResult(m));
					matchHeld(existing);
					return;
				}
				if (how === "user") {
					debug(`live: learner message → ${model.id}`);
					bindCall(existing, translator, options?.signal);
					existing.fed = [...fps];
					writeUser(existing, userContent(delta));
					return;
				}
			}
			debug(
				`fresh: ${model.id}, ${messages.length} message(s) — ${
					!existing ? "new conversation" : existing.state === "streaming" ? "session busy" : !isPrefixOf(existing.fed, fps) ? "history changed" : "not a continuation"
				}`,
			);
			if (existing) kill(existing); // not a continuation: this conversation starts over
			fresh();
		})
		.catch((err) => translator.fail(`Claude Code bridge failed: ${err instanceof Error ? err.message : String(err)}`));
	return stream;
}

// ─── plan usage ──────────────────────────────────────────────────────────────

/** The Claude plan's usage as Claude Code last reported it (every API
 *  response carries a rate_limit_event): utilization 0..1 per window. */
export interface ClaudePlanUsage {
	fiveHour?: { utilization: number; resetsAt: number };
	sevenDay?: { utilization: number; resetsAt: number };
	/** When this was reported (ms). */
	at: number;
}

const PLAN_KEY = Symbol.for("lh.claudePlanUsage");

function recordPlanUsage(info: unknown): void {
	const windows = (info as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> } | undefined)?.unifiedWindows;
	if (!windows) return;
	const pick = (w?: { utilization?: number; resetsAt?: number }) =>
		w && typeof w.utilization === "number" ? { utilization: w.utilization, resetsAt: (w.resetsAt ?? 0) * 1000 } : undefined;
	(globalThis as Record<symbol, ClaudePlanUsage | undefined>)[PLAN_KEY] = {
		fiveHour: pick(windows.five_hour),
		sevenDay: pick(windows.seven_day),
		at: Date.now(),
	};
}

/** The last reported plan usage; null before any Claude Code call. */
export function claudePlanUsage(): ClaudePlanUsage | null {
	return (globalThis as Record<symbol, ClaudePlanUsage | undefined>)[PLAN_KEY] ?? null;
}

/** The pi-ai provider. Auth is "configured" exactly when the CLI is
 *  installed; the CLI's own sign-in is the credential. */
export function claudeCodeProvider(): Provider {
	return createProvider({
		id: CLAUDE_CODE_PROVIDER_ID,
		name: "Claude Code (subscription)",
		auth: {
			apiKey: {
				name: "Claude Code sign-in",
				resolve: async () => (claudeCodeAvailable() ? { auth: {}, source: "claude CLI" } : undefined),
			},
		},
		models: claudeCodeModels(),
		api: { stream: streamClaudeCode, streamSimple: streamClaudeCode },
	});
}
