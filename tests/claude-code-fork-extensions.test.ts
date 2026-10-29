/**
 * Fork additions on top of upstream's Claude CLI provider (docs/android/m14-plan.md, 2026-10-29), ported from the fork's own provider's tests:
 * P1 replay elision (M11 Q2), P4 knobs, P5 child env, P3 plan usage, the live-process cap.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_IDLE_MIN, DEFAULT_MAX_SESSIONS, UPSTREAM_IDLE_MIN, elidedProblems, forkChildEnv, normalizeSketchContent, parseIdleMs, parseMaxSessions } from "../src/agent/claude-code/fork-extensions.ts";
import { toClaudeInput } from "../src/agent/claude-code/transcript.ts";
import { claudePlanUsage, observePlanUsage } from "../src/agent/claude-code/plan-usage.ts";
import { addLiveProcess, maxLiveProcesses, removeLiveProcess, type LiveProcess } from "../src/agent/claude-code/live-processes.ts";

type Msg = Record<string, unknown>;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string, t: number): Msg => ({ role: "user", content: text, timestamp: t });
const assistant = (blocks: Msg[], t: number): Msg => ({ role: "assistant", content: blocks, api: "x", provider: "x", model: "x", usage, stopReason: "toolUse", timestamp: t });
const call = (id: string, name: string, args: Record<string, unknown>): Msg => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, name: string, text: string, isError = false, t = 0): Msg => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: t });

const pose = (n: number): Msg[] => [
	assistant([call(`p${n}`, "problem", { statement: `Problem ${n}: find the area of triangle ${n}.` })], n * 10),
	result(`p${n}`, "problem", "Problem posed", false, n * 10 + 1),
	user(`thinking about problem ${n} SECRET-THINKING-${n}`, n * 10 + 2),
];
const conclude = (n: number, outcome: string, isError = false): Msg[] => [
	assistant([call(`c${n}`, "conclude", { outcome })], n * 10 + 3),
	result(`c${n}`, "conclude", isError ? "refused: a sketch is unread" : "Concluded", isError, n * 10 + 4),
];

const render = (messages: Msg[]) =>
	toClaudeInput(messages as never).userContent.map((b) => (b.type === "text" ? b.text : "[image]")).join("");
const asMessages = (messages: Msg[]) => messages as never;

test("a problem concluded before a later pose is replaced by one omitted-note", () => {
	const messages = [user("start", 1), ...pose(1), ...conclude(1, "solved"), assistant([{ type: "text", text: "Nice." }], 50), ...pose(2)];
	const spans = elidedProblems(asMessages(messages));
	assert.equal(spans.length, 1);
	assert.equal(spans[0]!.outcome, "solved");
	assert.equal(spans[0]!.from, 1);
	assert.equal(spans[0]!.to, 5, "through the conclude result");
	const text = render(messages);
	assert.match(text, /<omitted>An earlier practice problem \(Problem 1: find the area of triangle 1\.\) was concluded as solved/);
	assert.doesNotMatch(text, /SECRET-THINKING-1/, "the elided problem's thinking is not replayed");
	assert.match(text, /Nice\./, "what followed the conclude stays");
	assert.match(text, /SECRET-THINKING-2/, "the active problem stays in full");
	assert.match(text, /Problem 2: find the area/);
});

test("the active problem is never elided, even when it was concluded", () => {
	const messages = [user("start", 1), ...pose(1), ...conclude(1, "solved")];
	assert.deepEqual(elidedProblems(asMessages(messages)), []);
	assert.match(render(messages), /SECRET-THINKING-1/);
});

test("a problem with no successful conclude before the next pose is kept", () => {
	const refused = [...pose(1), ...conclude(1, "solved", true), ...pose(2)];
	assert.deepEqual(elidedProblems(asMessages(refused)), [], "a refused conclude closes nothing");
	const never = [...pose(1), ...pose(2)];
	assert.deepEqual(elidedProblems(asMessages(never)), []);
	assert.match(render(refused), /SECRET-THINKING-1/);
});

test("several concluded problems each get a note; the last one stays", () => {
	const messages = [...pose(1), ...conclude(1, "solved"), ...pose(2), ...conclude(2, "movedOn"), ...pose(3)];
	const spans = elidedProblems(asMessages(messages));
	assert.deepEqual(spans.map((s) => s.outcome), ["solved", "movedOn"]);
	const text = render(messages);
	assert.equal(text.match(/<omitted>/g)?.length, 2);
	assert.doesNotMatch(text, /SECRET-THINKING-[12]\b/);
	assert.match(text, /SECRET-THINKING-3/);
});

test("a long statement is cut in the note, and a transcript without problems is untouched", () => {
	const long = "x".repeat(300);
	const messages = [assistant([call("pa", "problem", { statement: long })], 1), result("pa", "problem", "ok", false, 2), ...conclude(9, "surrendered"), ...pose(2)];
	assert.match(render(messages), /<omitted>An earlier practice problem \(x{120}…\)/);
	const plain = [user("hi", 1), assistant([{ type: "text", text: "hello" }], 2)];
	assert.deepEqual(elidedProblems(asMessages(plain)), []);
	assert.doesNotMatch(render(plain), /<omitted>/);
});

// ─── P4: the knobs ───────────────────────────────────────────────────────────

test("LH_CLAUDE_CODE_MAX_SESSIONS: a positive integer, anything else is the default 6", () => {
	assert.equal(DEFAULT_MAX_SESSIONS, 6);
	assert.equal(parseMaxSessions(undefined), 6);
	for (const bad of ["", " ", "0", "-1", "1.5", "two", "2x", "0x10", "1e3", "99999999999999999999"]) assert.equal(parseMaxSessions(bad), 6, bad);
	assert.equal(parseMaxSessions("1"), 1);
	assert.equal(parseMaxSessions(" 2 "), 2);
	assert.equal(parseMaxSessions("12"), 12);
});

test("LH_CLAUDE_IDLE_MIN: minutes as a positive integer, anything else is the default 40", () => {
	assert.equal(DEFAULT_IDLE_MIN, 40);
	assert.equal(parseIdleMs(undefined), 40 * 60_000);
	assert.equal(parseIdleMs(undefined, UPSTREAM_IDLE_MIN), 10 * 60_000, "idle reuse off: upstream's 10");
	for (const bad of ["", " ", "0", "-1", "1.5", "ten", "10m", "0x10", "1e3", "99999999999999999999"]) assert.equal(parseIdleMs(bad), 40 * 60_000, bad);
	assert.equal(parseIdleMs("15"), 15 * 60_000);
	assert.equal(parseIdleMs(" 1 "), 60_000);
});

test("the live-process registry keeps at most the cap: the oldest is killed first", () => {
	const killed: string[] = [];
	const made = (name: string): LiveProcess => ({ owner: Symbol(name), sessionId: name, toolCallIds: [], kill: () => void killed.push(name) });
	const saved = maxLiveProcesses.current;
	maxLiveProcesses.current = 2;
	const processes = ["a", "b", "c"].map(made);
	try {
		for (const p of processes) addLiveProcess(p);
		assert.deepEqual(killed, ["a"], "the third process pushed the oldest out");
	} finally {
		maxLiveProcesses.current = saved;
		for (const p of processes) removeLiveProcess(p);
	}
});

// ─── P5: the child's environment ─────────────────────────────────────────────

test("the CLI never receives the app's own access token; every other variable passes through", () => {
	const env = forkChildEnv({ LH_ACCESS_TOKEN: "secret", PATH: "/bin", ANTHROPIC_API_KEY: "kept-by-upstreams-rules" } as unknown as NodeJS.ProcessEnv);
	assert.equal(env.LH_ACCESS_TOKEN, undefined);
	assert.equal(env.PATH, "/bin");
	assert.equal(env.ANTHROPIC_API_KEY, "kept-by-upstreams-rules");
});

// ─── P3: plan usage ──────────────────────────────────────────────────────────

test("a rate_limit_event is recorded for the plan pill; other lines and noise are ignored", () => {
	const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1_800_000_000 }, seven_day: { utilization: 0.1, resetsAt: 1_800_100_000 } } } });
	observePlanUsage('{"type":"stream_event"}');
	observePlanUsage("not json at all rate_limit_event");
	observePlanUsage(line);
	const usage = claudePlanUsage();
	assert.equal(usage?.fiveHour?.utilization, 0.4);
	assert.equal(usage?.fiveHour?.resetsAt, 1_800_000_000_000, "seconds become milliseconds");
	assert.equal(usage?.sevenDay?.utilization, 0.1);
});

// ─── P2: sketch pages ────────────────────────────────────────────────────────

test("a sketch page reads the same as an image and as a stub; other text and images are untouched", () => {
	const label = "[sketch sk_abcdefgh12345678 · page 1/2]";
	const image = { type: "image", mimeType: "image/png", data: "AAAA" };
	const asImage = normalizeSketchContent([{ type: "text", text: label }, image, { type: "text", text: "tail" }] as never);
	const asStub = normalizeSketchContent([{ type: "text", text: `${label} (omitted — older than the newest 20 sketch pages)` }, { type: "text", text: "tail" }] as never);
	assert.deepEqual(asImage, asStub);
	assert.deepEqual(normalizeSketchContent([image] as never), [image], "a plain image is kept");
	assert.equal(normalizeSketchContent("text"), "text");
});
