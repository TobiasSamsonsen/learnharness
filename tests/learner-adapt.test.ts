/**
 * The Adapt pass (fork addition, 2026-11-11): the evidence digest, the draft's
 * bookkeeping, the submit agent against a scripted model, and the server seam
 * (stats, the 3-session floor, no stored draft).
 *
 * LH_DATA_DIR is set before the first import that loads config.ts, so the app
 * modules are imported dynamically.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-adapt-"));
process.env.LH_DATA_DIR = TMP_DATA;

const digestMod = await import("../src/core/learner-digest.ts");
const { draftLearnerClaims } = await import("../src/agent/subagents/adapt.ts");
const { learnerStats, runAdapt } = await import("../src/server/learner-adapt.ts");
const { writeSettings, readSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { GET: statsGET } = await import("../app/api/learner/route.ts");
const { POST: adaptPOST } = await import("../app/api/learner/adapt/route.ts");

import type { LhMessage } from "../src/core/native-messages.ts";
import type { DigestChat } from "../src/core/learner-digest.ts";

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const { ADAPT_DIGEST_MAX_CHARS, ADAPT_MIN_SESSIONS, adaptProblem, buildAdaptDigest, finalizeAdapt } = digestMod;

const T0 = Date.parse("2026-10-01T00:00:00Z");
const STAMPS = { api: "faux", provider: "faux", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" };
let seq = 0;
const assistant = (calls: Array<{ id: string; name: string; args: unknown }>, at: number): LhMessage =>
	({ id: `m${++seq}`, role: "assistant", content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args })), ...STAMPS, timestamp: at }) as unknown as LhMessage;
const result = (toolCallId: string, toolName: string, at: number, details?: unknown): LhMessage =>
	({ id: `m${++seq}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], isError: false, details, timestamp: at }) as unknown as LhMessage;

function problem(conclude: Record<string, unknown>, at: number, skills: string[] = ["sk_a"]): LhMessage[] {
	const p = `p${++seq}`;
	const c = `c${++seq}`;
	return [
		assistant([{ id: p, name: "problem", args: { statement: "S", mode: "recall", modelSolution: "M", skills } }], at),
		result(p, "problem", at),
		assistant([{ id: c, name: "conclude", args: { outcome: "solved", verdict: "v", rung: null, missClass: null, retest: false, ...conclude } }], at + 1),
		result(c, "conclude", at + 1),
	];
}
function answer(at: number, data: Record<string, unknown>): LhMessage[] {
	const id = `q${++seq}`;
	return [assistant([{ id, name: "quiz", args: {} }], at), result(id, "quiz", at + 1, { kind: "quiz", tool: "quiz", questionText: "What is 2+2?", dontKnow: false, answers: [], ...data })];
}

const practiceChat = (id: string, day: number, messages: LhMessage[]): DigestChat => ({
	id,
	kind: "practice",
	updatedAt: new Date(T0 + day * 86_400_000).toISOString(),
	messages,
});
const lessonChat = (id: string, day: number, messages: LhMessage[]): DigestChat => ({ id, updatedAt: new Date(T0 + day * 86_400_000).toISOString(), messages });

describe("buildAdaptDigest", () => {
	const chats = [
		practiceChat("old", 1, problem({ outcome: "solvedWithHints", rung: "R2", missClass: "careless", verdict: "Dropped a sign.\nFixed after a hint." }, T0)),
		lessonChat("lesson", 5, [...answer(T0, { correct: false, confidence: 95 }), ...answer(T0 + 10, { dontKnow: true }), ...answer(T0 + 20, { correct: true, confidence: 60 })]),
		practiceChat("new", 9, problem({ outcome: "solved" }, T0 + 100, ["sk_b"])),
		{ id: "empty", updatedAt: new Date(T0 + 10 * 86_400_000).toISOString(), messages: [] },
		{ id: "place", updatedAt: new Date(T0).toISOString(), course: { mode: "placement" as const }, messages: answer(T0, { correct: false, confidence: 99 }) },
	];

	it("lists the chats with evidence newest first, with tallies and verdicts", () => {
		const d = buildAdaptDigest(chats, (id) => (id === "sk_b" ? "Chain rule" : undefined));
		assert.deepEqual(d.chatIds, ["new", "lesson", "old"]);
		assert.equal(d.sessions, 3);
		assert.equal(d.ready, true);
		assert.equal(d.truncated, false);
		assert.match(d.text, /CHAT new \(practice, [\d-]+\), 1 concluded problem:/);
		assert.match(d.text, /skills: Chain rule/);
		assert.match(d.text, /CHAT lesson \(lesson, [\d-]+\): 3 answers, 1 wrong, 1 wrong at stated confidence >= 90, 1 "I don't know"/);
		assert.match(d.text, /- wrong at 95%: What is 2\+2\?/);
		assert.match(d.text, /miss: careless · skills: sk_a · verdict: Dropped a sign\. Fixed after a hint\./, "an unknown skill shows its id, and the verdict is on one line");
		assert.ok(!d.text.includes("CHAT place") && !d.text.includes("CHAT empty"));
	});

	it("needs evidence from three sessions", () => {
		assert.equal(buildAdaptDigest(chats.slice(0, 2)).ready, false);
		assert.equal(ADAPT_MIN_SESSIONS, 3);
	});

	it("cuts a long verdict to 300 characters", () => {
		const d = buildAdaptDigest([practiceChat("a", 1, problem({ verdict: "x".repeat(900) }, T0))]);
		const verdict = /verdict: (x+…?)/.exec(d.text)?.[1] ?? "";
		assert.ok(verdict.length <= 300, String(verdict.length));
	});

	it("leaves the oldest chats out beyond the cap and says so", () => {
		const big = (id: string, day: number) => practiceChat(id, day, Array.from({ length: 60 }, (_, i) => problem({ verdict: "y".repeat(280), missClass: "cue" }, T0 + i * 10)).flat());
		const many = Array.from({ length: 12 }, (_, i) => big(`c${i}`, i));
		const d = buildAdaptDigest(many);
		assert.equal(d.truncated, true);
		assert.ok(d.text.length <= ADAPT_DIGEST_MAX_CHARS);
		assert.equal(d.chatIds[0], "c11", "the newest is kept");
		assert.ok(!d.chatIds.includes("c0"), "the oldest is cut");
		assert.equal(d.sessions, 12, "cut chats still count as sessions");
	});
});

describe("finalizeAdapt", () => {
	const digest = { chatIds: ["a", "b", "c"], sessions: 3, truncated: false };
	const claim = (over: Record<string, unknown> = {}) => ({ kind: "mistake" as const, text: "Drops a sign", events: 4, chats: ["a", "b"], ...over });

	it("decides tentative itself: fewer than 3 events or 2 chats", () => {
		const d = finalizeAdapt(
			{
				claims: [claim(), claim({ events: 2 }), claim({ chats: ["a"] }), claim({ events: 9, chats: ["a", "a", "b"] })],
				gaps: [],
			},
			digest,
		);
		assert.deepEqual(d.claims.map((c) => c.tentative), [false, true, true, false]);
	});

	it("drops cited chats it never listed, and a claim left with none", () => {
		const d = finalizeAdapt({ claims: [claim({ chats: ["a", "ghost"] }), claim({ chats: ["ghost"] })], gaps: [] }, digest);
		assert.equal(d.claims.length, 1);
		assert.deepEqual(d.claims[0]!.chats, ["a"]);
	});

	it("never claims fewer events than chats it cites, drops over-long text, and trims gaps", () => {
		const d = finalizeAdapt({ claims: [claim({ events: 1, chats: ["a", "b", "c"] }), claim({ text: "z".repeat(301) })], gaps: ["  no data on style  ", " "] }, digest);
		assert.equal(d.claims.length, 1);
		assert.equal(d.claims[0]!.events, 3);
		assert.deepEqual(d.gaps, ["no data on style"]);
		assert.equal(d.sessions, 3);
	});

	it("adaptProblem asks the model to fix too many claims or a long text", () => {
		assert.equal(adaptProblem({ claims: [claim()], gaps: [] }), null);
		assert.match(adaptProblem({ claims: Array.from({ length: 13 }, () => claim()), gaps: [] }) ?? "", /at most 12/);
		assert.match(adaptProblem({ claims: [claim({ text: "z".repeat(301) })], gaps: [] }) ?? "", /at most 300/);
	});
});

describe("the Adapt agent (scripted model)", () => {
	function engine(steps: FauxResponseStep[]) {
		const faux = createFauxCore({});
		faux.setResponses(steps);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	}
	const submit = (input: unknown, id: string) => () => fauxAssistantMessage([fauxToolCall("submit_profile", input as ToolCall["arguments"], { id })], { stopReason: "toolUse" });

	it("returns the submitted claims and gaps, and sees the digest", async () => {
		let seen = "";
		const good = { claims: [{ kind: "mistake", text: "Drops a sign", events: 3, chats: ["a", "b"] }], gaps: ["No evidence about presentation style."] };
		const out = await draftLearnerClaims("CHAT a (practice, 2026-10-01)", {
			engine: engine([
				(ctx) => {
					seen = JSON.stringify(ctx.messages);
					return submit(good, "c1")();
				},
			]),
		});
		assert.match(seen, /CHAT a \(practice, 2026-10-01\)/);
		assert.deepEqual(out, good);
	});

	it("sends a claim with too-long text back, and accepts the corrected one", async () => {
		const bad = { claims: [{ kind: "mistake", text: "z".repeat(301), events: 3, chats: ["a"] }], gaps: [] };
		const good = { claims: [{ kind: "pacing", text: "Slow to start", events: 3, chats: ["a"] }], gaps: [] };
		const out = await draftLearnerClaims("d", { engine: engine([submit(bad, "c1"), submit(good, "c2")]) });
		assert.equal(out.claims[0]!.text, "Slow to start");
	});

	it("throws when the model never submits", async () => {
		await assert.rejects(draftLearnerClaims("d", { engine: engine([() => fauxAssistantMessage("no")]) }), /never submitted/);
	});
});

describe("the server seam", () => {
	function seedPractice(title: string, n: number, missClass: string | null) {
		const chat = chatStore.createChat(title, "practice");
		chatStore.saveMessages(chat.id, Array.from({ length: n }, (_, i) => problem({ missClass, outcome: "solvedWithHints", verdict: "v" }, T0 + i * 10)).flat());
		return chat.id;
	}

	it("reports stats with the floors' verdicts, and Adapt is not ready below 3 sessions", async () => {
		seedPractice("a", 3, "execution");
		seedPractice("b", 3, "execution");
		const stats = learnerStats(T0 + 1000);
		assert.equal(stats.fold.classified, 6);
		assert.equal(stats.fold.missesShown, true);
		assert.equal(stats.sessions, 2);
		assert.equal(stats.adaptReady, false);
		const res = await statsGET();
		assert.equal(res.status, 200);
		assert.equal(((await res.json()) as { sessions: number }).sessions, 2);

		const refused = await runAdapt();
		assert.deepEqual([refused.ok, refused.ok ? 0 : refused.status], [false, 409]);
		const viaRoute = await adaptPOST(new Request("http://x", { method: "POST" }));
		assert.equal(viaRoute.status, 409);
	});

	it("refuses with no model once there is enough evidence, and stores nothing", async () => {
		seedPractice("c", 2, "careless");
		const before = JSON.stringify(readSettings());
		const out = await runAdapt();
		assert.deepEqual([out.ok, out.ok ? 0 : out.status], [false, 503]);
		writeSettings({ ...(readSettings() ?? { version: 1 }) });
		assert.equal(JSON.stringify(readSettings()?.learner), JSON.stringify(JSON.parse(before)?.learner), "no draft was written to the settings");
	});
});
