/**
 * GRADER VISIBILITY AND FALLBACK (owner, 2026-11-13): the readable failure
 * reason, the fallback to the session's model, the concluded card's two notes,
 * "Grade again" (route + record rewrite) and the sync rule that keeps a graded
 * conclude result over an ungraded copy.
 *
 * LH_DATA_DIR is set before the first import that loads config.ts, so the app
 * modules are imported dynamically.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup as renderBare } from "react-dom/server";
import { InteractionLayersProvider } from "../components/interaction-layers";

const renderToStaticMarkup = (node: React.ReactElement) => renderBare(<InteractionLayersProvider>{node}</InteractionLayersProvider>);

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-grade-fallback-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { gradeFailureReason, gradeNoteOf, isUngraded, NO_GRADER_MODEL } = await import("../src/core/grade-failure.ts");
const { gradeWithFallback, regradeConcludedProblem } = await import("../src/server/practice-grade.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { mergeFile } = await import("../src/core/sync-merge.ts");
const { ConcludeCard } = await import("../components/practice-cards.tsx");
const { ChatActionsContext } = await import("../components/chat.tsx");
const { courseStore } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const courses = await import("../src/server/courses.ts");
const { POST } = await import("../app/api/chats/[id]/regrade/route.ts");
const { skillEventsOf } = await import("../src/core/mastery.ts");

import type { ArtifactPartProps } from "../src/core";
import type { LhMessage } from "../src/core/native-messages.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const quiet = async <T,>(run: () => Promise<T>): Promise<T> => {
	const original = console.warn;
	console.warn = () => {};
	try {
		return await run();
	} finally {
		console.warn = original;
	}
};

const GOOGLE_402 = `{"error":{"message":"{\\n \\"error\\": {\\n \\"code\\": 402,\\n \\"message\\": \\"Your prepayment credits are depleted. Please go to AI Studio\\",\\n \\"status\\": \\"RESOURCE_EXHAUSTED\\"\\n }\\n}"}}`;

describe("gradeFailureReason", () => {
	it("names the known causes and the provider", () => {
		assert.equal(gradeFailureReason(GOOGLE_402, { provider: "google" }), "out of credit (Google)");
		assert.equal(gradeFailureReason(`{"code": 429, "message": "You exceeded your current quota"}`, { provider: "google" }), "quota or rate limit reached (Google)");
		assert.equal(gradeFailureReason("401 Unauthorized", { provider: "anthropic" }), "API key rejected (Anthropic)");
		assert.equal(gradeFailureReason("403 permission denied", { provider: "openai" }), "API key rejected (OpenAI)");
		assert.equal(gradeFailureReason(`{"code": 503, "message": "This model is currently experiencing high demand."}`, { provider: "google" }), "provider unavailable (Google)");
		assert.equal(gradeFailureReason("The operation was aborted due to timeout", { provider: "google", timedOut: true }), "timed out (Google)");
	});

	it("an unknown provider id is shown as it is, and no provider leaves the reason bare", () => {
		assert.equal(gradeFailureReason("500 Internal Server Error", { provider: "claude-code" }), "provider unavailable (claude-code)");
		assert.equal(gradeFailureReason("boom"), "boom");
	});

	it("anything else is the start of the message, on one line, at most 120 characters", () => {
		const long = `the practice grader never submitted\n${"x".repeat(200)}`;
		const reason = gradeFailureReason(long);
		assert.ok(reason.startsWith("the practice grader never submitted x"));
		assert.equal(reason.length, 121, "120 characters and the ellipsis");
		assert.equal(gradeFailureReason(""), "unknown error");
	});

	it("a missing grader model keeps its own wording, with no provider", () => {
		assert.equal(gradeFailureReason(NO_GRADER_MODEL, { provider: "google" }), NO_GRADER_MODEL);
	});

	it("reads the note off a conclude result, and tells an ungraded one", () => {
		assert.deepEqual(gradeNoteOf({ grades: [], gradeError: "x", gradedBy: "session" }), { gradedBy: "session", gradeError: "x" });
		assert.deepEqual(gradeNoteOf({ grades: [], gradeError: 4, gradedBy: "tutor" }), {});
		assert.deepEqual(gradeNoteOf(null), {});
		assert.equal(isUngraded({ grades: [] }), true);
		assert.equal(isUngraded({ grades: [{ skill: "a", grade: "good" }] }), false);
		assert.equal(isUngraded({}), false, "no list: a grading never ran");
		assert.equal(isUngraded(null), false);
	});
});

describe("gradeWithFallback", () => {
	const grader = { provider: "google", id: "gemini" };
	const session = { provider: "anthropic", id: "claude-sonnet-5-5" };
	const grades = [{ skill: "sk_a", grade: "hard" as const }];

	it("the grader's own grades carry no note, and the session's model is never asked", async () => {
		const asked: string[] = [];
		const out = await gradeWithFallback({ grader, session }, async (spec) => (asked.push(spec.provider), grades));
		assert.deepEqual(out, { grades });
		assert.deepEqual(asked, ["google"]);
	});

	it("a failed grader falls back to the session's model and says so", async () => {
		const out = await quiet(() =>
			gradeWithFallback({ grader, session }, async (spec) => {
				if (spec.provider === "google") throw new Error(GOOGLE_402);
				return grades;
			}),
		);
		assert.deepEqual(out, { grades, gradedBy: "session", gradeError: "out of credit (Google)" });
	});

	it("both failing leaves no grades and the grader's reason", async () => {
		const out = await quiet(() =>
			gradeWithFallback({ grader, session }, async (spec) => {
				throw new Error(spec.provider === "google" ? GOOGLE_402 : "503 overloaded");
			}),
		);
		assert.deepEqual(out, { grades: [], gradeError: "out of credit (Google)" });
	});

	it("no second attempt on the same model, or with no session model", async () => {
		let calls = 0;
		const fail = async () => {
			calls++;
			throw new Error("503");
		};
		assert.deepEqual(await quiet(() => gradeWithFallback({ grader, session: { ...grader, thinkingLevel: "high" } }, fail)), { grades: [], gradeError: "provider unavailable (Google)" });
		assert.deepEqual(await quiet(() => gradeWithFallback({ grader, session: undefined }, fail)), { grades: [], gradeError: "provider unavailable (Google)" });
		assert.equal(calls, 2);
	});

	it("no grader model set: the session's model grades, and the reason says what is missing", async () => {
		const out = await gradeWithFallback({ grader: undefined, session }, async () => grades);
		assert.deepEqual(out, { grades, gradedBy: "session", gradeError: NO_GRADER_MODEL });
	});

	it("a grader past its limit is a timeout, and the fallback still runs", async () => {
		const out = await quiet(() =>
			gradeWithFallback(
				{ grader, session },
				(spec, signal) =>
					spec.provider === "google"
						? new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))
						: Promise.resolve(grades),
				undefined,
				{ graderMs: 20, fallbackMs: 1000 },
			),
		);
		assert.deepEqual(out, { grades, gradedBy: "session", gradeError: "timed out (Google)" });
	});

	it("a stopped turn throws and tries nothing further", async () => {
		const stop = new AbortController();
		let calls = 0;
		await assert.rejects(
			gradeWithFallback(
				{ grader, session },
				async () => {
					calls++;
					stop.abort();
					throw new Error("aborted");
				},
				stop.signal,
			),
		);
		assert.equal(calls, 1);
	});
});

// ─── the card ───────────────────────────────────────────────────────────────

const part = (input: Record<string, unknown>, output?: unknown): ArtifactPartProps["part"] => ({
	type: "tool-conclude",
	state: "output-available",
	toolCallId: "call_c1",
	input,
	...(output !== undefined ? { output } : {}),
});
const ctx = { chatId: "chat_1", syncFromServer: async () => {}, sendText: () => {}, openSetup: () => {} };
const card = (output?: unknown) =>
	renderToStaticMarkup(
		<ChatActionsContext.Provider value={ctx as never}>
			<ConcludeCard part={part({ outcome: "solved", verdict: "v" }, output)} />
		</ChatActionsContext.Provider>,
	);

describe("ConcludeCard grading notes", () => {
	it("shows nothing new when the grader graded, or when no grading ran", () => {
		for (const html of [card({ grades: [{ skill: "sk_a", grade: "good" }] }), card(), card({ tool: "conclude" })]) {
			assert.ok(!html.includes("Not graded"));
			assert.ok(!html.includes("Graded by the session"));
			assert.ok(!html.includes("Grade again"));
		}
	});

	it("a fallback grading gets one quiet line with the reason, and no button", () => {
		const html = card({ grades: [{ skill: "sk_a", grade: "hard" }], gradedBy: "session", gradeError: "out of credit (Google)" });
		assert.match(html, /Graded by the session(&#x27;|')s model\. The grader failed: out of credit \(Google\)\./);
		assert.ok(!html.includes("Grade again"));
		assert.ok(!html.includes("Not graded"));
	});

	it("nothing graded: Not graded, the reason, the default, and Grade again", () => {
		const html = card({ grades: [], gradeError: "out of credit (Google)" });
		assert.match(html, /Not graded\. The grader failed: out of credit \(Google\)\. A cautious default grade applies\./);
		assert.match(html, /<button[^>]*>Grade again<\/button>/);
	});

	it("an older ungraded problem has no reason to show", () => {
		const html = card({ grades: [] });
		assert.match(html, /Not graded\. A cautious default grade applies\./);
		assert.ok(!html.includes("The grader failed"));
		assert.ok(html.includes("Grade again"));
	});
});

// ─── Grade again ────────────────────────────────────────────────────────────

const STAMPS = { api: "faux", provider: "test", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" };
let t = 1000;
const assistant = (content: unknown[]): LhMessage => ({ id: `m${t}`, role: "assistant", content, ...STAMPS, timestamp: t++ }) as unknown as LhMessage;
const toolResult = (toolCallId: string, toolName: string, details: unknown = null): LhMessage =>
	({ id: `m${t}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], details, isError: false, timestamp: t++ }) as unknown as LhMessage;

/** A practice course session on one skill, holding one concluded problem whose result has `details`. */
function practiceSession(details: unknown): { chatId: string; skill: string } {
	const course = courseStore.createCourse("Calc");
	courseStore.updateCourse(course.id, {
		status: "draft",
		draft: { createdAt: "t", summary: "s", skills: [{ key: "s1", name: "A", statement: "Do a", requires: [], restsOn: [] }] },
	});
	const approved = courses.approveCourse(course.id);
	assert.ok(approved.ok);
	const skill = approved.value.skills[0]!;
	const session = courses.createCourseSession(course.id, "practice", skill);
	assert.ok(session.ok);
	const chatId = session.value.id;
	const before = chatStore.getChat(chatId)!.messages;
	chatStore.saveMessages(chatId, [
		...before,
		assistant([{ type: "toolCall", id: "p1", name: "problem", arguments: { statement: "Solve it", mode: "recall", modelSolution: "42", skills: [skill] } }]),
		toolResult("p1", "problem"),
		assistant([{ type: "toolCall", id: "c1", name: "conclude", arguments: { outcome: "solved", verdict: "Clean.", rung: null, missClass: null, retest: false } }]),
		toolResult("c1", "conclude", details),
	]);
	return { chatId, skill };
}
const concludeDetails = (chatId: string) =>
	(chatStore.getChat(chatId)!.messages.find((m) => (m as { toolCallId?: string }).toolCallId === "c1" && (m as { role?: string }).role === "toolResult") as { details?: unknown }).details;

describe("regradeConcludedProblem", () => {
	it("grades the stored problem, rewrites only that result, and the fold reads the new grade", async () => {
		const { chatId, skill } = practiceSession({ tool: "conclude", grades: [], gradeError: "out of credit (Google)" });
		const count = chatStore.getChat(chatId)!.messages.length;
		let seen: { skills?: unknown; transcript?: string } = {};
		const out = await regradeConcludedProblem(chatId, "c1", async (input) => {
			seen = input;
			return { grades: [{ skill, grade: "good" }] };
		});
		assert.deepEqual(out, { ok: true });
		assert.deepEqual(seen.skills, [{ id: skill, name: "A" }]);
		assert.match(seen.transcript ?? "", /PROBLEM \(recall\): Solve it/);
		assert.deepEqual(concludeDetails(chatId), { tool: "conclude", grades: [{ skill, grade: "good" }] }, "the old reason is gone, other fields stay");
		const record = chatStore.getChat(chatId)!;
		assert.equal(record.messages.length, count);
		assert.equal(skillEventsOf(record.messages, record.course!).find((e) => e.skillId === skill)?.grade, "good");
	});

	it("a fallback grading stores who graded and why", async () => {
		const { chatId, skill } = practiceSession({ grades: [] });
		const out = await regradeConcludedProblem(chatId, "c1", async () => ({ grades: [{ skill, grade: "hard" }], gradedBy: "session", gradeError: "out of credit (Google)" }));
		assert.deepEqual(out, { ok: true });
		assert.deepEqual(concludeDetails(chatId), { grades: [{ skill, grade: "hard" }], gradedBy: "session", gradeError: "out of credit (Google)" });
	});

	it("a grading that fails again leaves the record as it was and says why", async () => {
		const { chatId } = practiceSession({ grades: [], gradeError: "old reason" });
		const out = await regradeConcludedProblem(chatId, "c1", async () => ({ grades: [], gradeError: "out of credit (Google)" }));
		assert.deepEqual(out, { ok: false, status: 502, error: "The grader failed: out of credit (Google)." });
		assert.deepEqual(concludeDetails(chatId), { grades: [], gradeError: "old reason" });
	});

	it("refuses while a turn runs, before grading and again before the write", async () => {
		const { chatId, skill } = practiceSession({ grades: [] });
		let calls = 0;
		assert.ok(beginTurn(chatId));
		const blocked = await regradeConcludedProblem(chatId, "c1", async () => (calls++, { grades: [{ skill, grade: "good" }] }));
		endTurn(chatId);
		assert.equal(blocked.ok, false);
		assert.equal(!blocked.ok && blocked.status, 409);
		assert.equal(calls, 0, "no grading call while the tutor is writing");

		const late = await regradeConcludedProblem(chatId, "c1", async () => {
			assert.ok(beginTurn(chatId)); // a turn starts while the grader runs
			return { grades: [{ skill, grade: "good" }] };
		});
		endTurn(chatId);
		assert.equal(!late.ok && late.status, 409);
		assert.deepEqual(concludeDetails(chatId), { grades: [] }, "nothing was written under the turn");
	});

	it("refuses an already graded problem, an unknown one, and a session that is not course practice", async () => {
		const { chatId, skill } = practiceSession({ grades: [{ skill: "x", grade: "good" }] });
		const never = async () => ({ grades: [{ skill, grade: "good" as const }] });
		const graded = await regradeConcludedProblem(chatId, "c1", never);
		assert.equal(!graded.ok && graded.status, 409);
		const unknown = await regradeConcludedProblem(chatId, "nope", never);
		assert.equal(!unknown.ok && unknown.status, 404);
		const plain = chatStore.createChat("Plain", "practice");
		const notCourse = await regradeConcludedProblem(plain.id, "c1", never);
		assert.equal(!notCourse.ok && notCourse.status, 404);
		const missing = await regradeConcludedProblem("chat_nope", "c1", never);
		assert.equal(!missing.ok && missing.status, 404);
	});

	it("the route validates its body and reports the refusal", async () => {
		const call = (id: string, body: unknown) =>
			POST(new Request(`http://x/api/chats/${id}/regrade`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
		assert.equal((await call("chat_nope", {})).status, 400);
		const res = await call("chat_nope", { toolCallId: "c1" });
		assert.equal(res.status, 404);
		assert.ok(((await res.json()) as { error?: unknown }).error);
	});
});

// ─── sync ───────────────────────────────────────────────────────────────────

describe("mergeFile: a graded conclude result beats an ungraded copy", () => {
	const msg = (id: string) => ({ id, role: "user", content: id, timestamp: 1 });
	const conclude = (details: unknown) => ({ id: "r1", role: "toolResult", toolCallId: "c1", toolName: "conclude", content: [], details, isError: false, timestamp: 2 });
	const chat = (over: Record<string, unknown>) => ({ id: "chat_1", title: "T", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", messages: [], version: 2, ...over });
	const graded = conclude({ grades: [{ skill: "sk_a", grade: "good" }] });
	const ungraded = conclude({ grades: [], gradeError: "out of credit (Google)" });
	const mergedMessages = (local: unknown, remote: unknown, base: unknown) => {
		const r = mergeFile({ path: "chats/chat_1.json", base: JSON.stringify(base), prefer: "local", local: JSON.stringify(local), remote: JSON.stringify(remote) });
		return (JSON.parse(r.content ?? "null") as { messages: unknown[] }).messages;
	};
	const base = chat({ messages: [msg("a"), ungraded] });

	it("the re-graded side keeps its grades when the other side appended", () => {
		const regraded = chat({ messages: [msg("a"), graded], updatedAt: "2026-01-02T00:00:00Z" });
		const appended = chat({ messages: [msg("a"), ungraded, msg("b")], updatedAt: "2026-01-03T00:00:00Z" });
		assert.deepEqual(mergedMessages(regraded, appended, base), [msg("a"), graded, msg("b")]);
		assert.deepEqual(mergedMessages(appended, regraded, base), [msg("a"), graded, msg("b")]);
	});

	it("the re-graded side keeps its grades when the other side only renamed the chat", () => {
		const regraded = chat({ messages: [msg("a"), graded], updatedAt: "2026-01-02T00:00:00Z" });
		const renamed = chat({ messages: [msg("a"), ungraded], title: "New", updatedAt: "2026-01-03T00:00:00Z" });
		assert.deepEqual(mergedMessages(regraded, renamed, base), [msg("a"), graded]);
		assert.deepEqual(mergedMessages(renamed, regraded, base), [msg("a"), graded]);
	});

	it("two graded copies are left alone", () => {
		const other = conclude({ grades: [{ skill: "sk_a", grade: "hard" }] });
		const l = chat({ messages: [msg("a"), graded], title: "L", updatedAt: "2026-01-02T00:00:00Z" });
		const r = chat({ messages: [msg("a"), other, msg("b")], updatedAt: "2026-01-03T00:00:00Z" });
		assert.deepEqual(mergedMessages(l, r, base), [msg("a"), other, msg("b")]);
	});
});
