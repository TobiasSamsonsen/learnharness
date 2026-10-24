import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
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
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

/**
 * THE CLAUDE CODE PROVIDER (fork addition, 2026-10-24): model turns run
 * through the locally installed `claude` CLI, so the user's Claude
 * subscription — the CLI's own sign-in — pays for them instead of an API
 * key. The app never sees or stores a credential; Claude Code owns auth.
 *
 * One pi-ai turn = one `claude -p` process:
 *   - the replayed system prompt (+ a short transport note) goes in via
 *     --system-prompt-file; Claude Code's own prompt and built-in tools
 *     are off (--tools "", --setting-sources "", --strict-mcp-config);
 *   - the app's tools are declared to the model through a stub MCP server
 *     whose calls do nothing — the model's tool_use blocks are captured
 *     from the stream and handed back to pi's agent loop, which runs the
 *     real tools exactly as it does for every other provider;
 *   - the transcript so far is ONE user message (stream-json input, so
 *     images ride inline as real image blocks) — Claude Code cannot replay
 *     a foreign assistant history natively;
 *   - the first API message's raw stream events map 1:1 onto pi's event
 *     protocol (the same mapping pi-ai's anthropic-messages adapter uses);
 *     at its message_stop the turn is complete and the process is killed
 *     before Claude Code's own loop would run anything.
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

function findOnPath(): string | undefined {
	const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";").filter(Boolean) : [""];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = path.join(dir, `claude${ext.toLowerCase()}`);
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
		}
	}
	return fallbackBins().find((p) => fs.existsSync(p));
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
This conversation runs through Claude Code. Everything said so far arrives as one transcript in the user message, made of <user>, <assistant> and <tool_result> elements; your own earlier tool calls appear in it as <tool_call> records, their string arguments shown verbatim (unescaped). Those records are history, not a format to write: writing one as text does nothing. Write only the assistant's next message. The tools named in these instructions are available to you with the ${TOOL_PREFIX} prefix (for example, a tool called "plan" is ${TOOL_PREFIX}plan). To use one, call it with your tool-calling ability — never write a <tool_call> element yourself. Each tool's result arrives in a later turn.
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
	/<tool_call\b[^>]*?\bname="([^"]+)"[^>]*>([\s\S]*?)<\/tool_call>/g,
	/<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g,
];
const TEXT_PARAM = /<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g;
/** Wrapper debris left once the calls inside it are lifted out. */
const CALL_DEBRIS = /<\/?(?:tool_call|invoke|function_calls)\b[^>]*>/g;

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
					block.text += delta.text;
					stream.push({ type: "text_delta", contentIndex: i, delta: delta.text, partial: output });
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
			if (block.type === "text") stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: output });
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

	/** A turn with no native call but a call WRITTEN as text: recover the
	 *  calls into real toolCall blocks (the streamed text stays as it was;
	 *  the final message — what the record keeps — loses the fake). */
	private salvage(): void {
		if (this.blocks.some((b) => b.type === "toolCall")) return;
		const recovered: ToolCall[] = [];
		const content: Block[] = [];
		for (const block of this.blocks) {
			if (block.type !== "text" || !/<(?:tool_call|invoke)\b/.test(block.text)) {
				content.push(block);
				continue;
			}
			const { text, calls } = salvageTextToolCalls(block.text, this.tools);
			recovered.push(...calls);
			if (text) content.push({ ...block, text });
		}
		if (recovered.length === 0) return;
		this.output.content = [...content, ...recovered];
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

// ─── the process ─────────────────────────────────────────────────────────────

/** The do-nothing MCP server (newline-delimited JSON-RPC over stdio):
 *  it only declares the tools; calls are never awaited by the app. */
const MCP_STUB = `import { readFileSync } from "node:fs";
const tools = JSON.parse(readFileSync(process.argv[2], "utf8"));
let buf = "";
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
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
		else if (msg.method === "tools/call") send({ id: msg.id, result: { content: [{ type: "text", text: "Handled by LearnHarness." }] } });
		else send({ id: msg.id, error: { code: -32601, message: "method not found" } });
	}
});
`;

const WORK_ROOT = path.join(os.tmpdir(), "learnharness-claude-code");

function stubPath(): string {
	const file = path.join(WORK_ROOT, "mcp-stub.mjs");
	fs.mkdirSync(WORK_ROOT, { recursive: true });
	if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== MCP_STUB) fs.writeFileSync(file, MCP_STUB);
	return file;
}

/** The child's env: the app's own Anthropic credentials stripped, so the
 *  CLI bills the subscription and not a key the user saved for the
 *  plain Anthropic provider; nested-session markers dropped. */
function childEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
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

function streamClaudeCode(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
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

	const workDir = path.join(WORK_ROOT, randomUUID());
	fs.mkdirSync(workDir, { recursive: true });
	const systemFile = path.join(workDir, "system-prompt.md");
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
	const effort = claudeCodeEffort(model, options?.reasoning);
	if (effort) args.push("--effort", effort);
	if (request.tools.length > 0) {
		const toolsFile = path.join(workDir, "tools.json");
		fs.writeFileSync(
			toolsFile,
			JSON.stringify(request.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }))),
		);
		const mcpFile = path.join(workDir, "mcp.json");
		fs.writeFileSync(
			mcpFile,
			JSON.stringify({
				mcpServers: {
					[MCP_SERVER]: {
						command: process.execPath,
						args: [stubPath(), toolsFile],
						// process.execPath is Electron in the packaged app
						env: { ELECTRON_RUN_AS_NODE: "1" },
					},
				},
			}),
		);
		args.push("--mcp-config", mcpFile);
	}

	const child = spawnClaude(bin, args, workDir);
	let stderr = "";
	const cleanup = () => {
		options?.signal?.removeEventListener("abort", onAbort);
		if (child.exitCode === null && !child.killed) child.kill();
		fs.rm(workDir, { recursive: true, force: true }, () => {});
	};
	const onAbort = () => {
		translator.fail("Request was aborted", "aborted");
		cleanup();
	};
	options?.signal?.addEventListener("abort", onAbort, { once: true });

	let buffer = "";
	child.stdout!.setEncoding("utf8");
	child.stdout!.on("data", (chunk: string) => {
		buffer += chunk;
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // non-JSON noise (a CLI banner) is not part of the protocol
			}
			translator.push(parsed);
			if (translator.finished) {
				cleanup();
				return;
			}
		}
	});
	child.stderr!.setEncoding("utf8");
	child.stderr!.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4000);
	});
	child.on("error", (err) => {
		translator.fail(`Could not start Claude Code (${bin}): ${err.message}`);
		cleanup();
	});
	child.on("close", (code) => {
		if (!translator.finished) {
			const tail = stderr.trim().split("\n").slice(-3).join(" ").trim();
			translator.fail(`Claude Code exited (code ${code ?? "?"}) before finishing the turn${tail ? ` — ${tail}` : ""}`);
		}
		cleanup();
	});

	child.stdin!.on("error", () => {}); // a CLI that dies early closes the pipe; close reports it
	child.stdin!.end(
		JSON.stringify({ type: "user", message: { role: "user", content: request.content } }) + "\n",
	);
	return stream;
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
