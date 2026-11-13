/**
 * WHAT A CONCLUDED PROBLEM DID TO ITS SKILLS (owner, 2026-11-13): the server folds every course's evidence before each
 * problem of a practice session and with it; the conclude card shows "understanding 3.1 -> 4.2 · review in 5 days".
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rating-change-"));
process.env.LH_DATA_DIR = TMP_DATA;

const courses = await import("../src/server/courses.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { GET } = await import("../app/api/chats/[id]/rating-changes/route.ts");
const ui = await import("../components/rating-change.tsx");

import type { LhMessage } from "../src/core/native-messages.ts";
import type { RatingChange } from "../src/core";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const STAMPS = { api: "faux", provider: "test", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" };
const DAY = 86_400_000;
let seq = 0;
const assistant = (content: unknown[], timestamp: number): LhMessage => ({ id: `m${++seq}`, role: "assistant", content, ...STAMPS, timestamp }) as unknown as LhMessage;
const result = (toolCallId: string, toolName: string, timestamp: number, details: unknown = null): LhMessage =>
	({ id: `m${++seq}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], details, isError: false, timestamp }) as unknown as LhMessage;
/** One posed-and-concluded problem on `skill`, concluded at `at`. */
const problem = (skill: string, at: number, outcome: string, grade: string): LhMessage[] => {
	const p = `p${++seq}`;
	const c = `c${++seq}`;
	return [
		assistant([{ type: "toolCall", id: p, name: "problem", arguments: { statement: "S", mode: "recall", modelSolution: "M", skills: [skill] } }], at - 1),
		result(p, "problem", at - 1),
		assistant([{ type: "toolCall", id: c, name: "conclude", arguments: { outcome, verdict: "v", rung: null, missClass: null, retest: false } }], at),
		result(c, "conclude", at, { grades: [{ skill, grade }] }),
	];
};
const callIdOf = (m: LhMessage): string => (m as unknown as { content: Array<{ id: string }> }).content[0]!.id;

describe("ratingChanges", () => {
	it("gives each concluded problem's skills their understanding before and after, and a review date", async () => {
		const course = courseStore.createCourse("Calc");
		courseStore.updateCourse(course.id, { status: "draft", draft: { createdAt: "t", summary: "s", skills: [{ key: "s1", name: "Product rule", statement: "Do a", requires: [], restsOn: [] }] } });
		const approved = courses.approveCourse(course.id);
		assert.ok(approved.ok);
		const skill = approved.value.skills[0]!;
		const session = courses.createCourseSession(course.id, "practice", skill);
		assert.ok(session.ok);
		const chatId = session.value.id;
		const now = Date.now();
		const first = problem(skill, now - 3 * DAY, "solvedWithHints", "hard");
		const second = problem(skill, now - 1 * DAY, "solved", "good");
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, ...first, ...second]);

		const changes = courses.ratingChanges(chatId)!;
		assert.equal(changes.length, 2);
		const [a, b] = changes as [RatingChange, RatingChange];
		assert.equal(a.callId, callIdOf(first[2]!));
		assert.equal(a.skills[0]!.id, skill);
		assert.equal(a.skills[0]!.name, "Product rule");
		assert.equal(a.skills[0]!.before, 0, "not learned before the first problem");
		assert.ok(a.skills[0]!.after > 0, "a hinted solve still learns it");
		assert.equal(b.skills[0]!.before, a.skills[0]!.after, "the second problem starts where the first left it");
		assert.ok(b.skills[0]!.after > b.skills[0]!.before, "a clean solve on a later day grows it");
		assert.ok(a.skills[0]!.reviewAt);

		const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: chatId }) });
		assert.equal(res.status, 200);
		assert.equal(((await res.json()) as { changes: RatingChange[] }).changes.length, 2);
	});

	it("a miss on a skill never learned changes nothing; other sessions have no changes", async () => {
		const course = courseStore.createCourse("Phys");
		courseStore.updateCourse(course.id, { status: "draft", draft: { createdAt: "t", summary: "s", skills: [{ key: "s1", name: "Torque", statement: "Do a", requires: [], restsOn: [] }] } });
		const approved = courses.approveCourse(course.id);
		assert.ok(approved.ok);
		const skill = approved.value.skills[0]!;
		const practice = courses.createCourseSession(course.id, "practice", skill);
		assert.ok(practice.ok);
		const miss = problem(skill, Date.now() - DAY, "surrendered", "again");
		chatStore.saveMessages(practice.value.id, [...chatStore.getChat(practice.value.id)!.messages, ...miss]);
		const changes = courses.ratingChanges(practice.value.id)!;
		assert.equal(changes.length, 1);
		assert.deepEqual([changes[0]!.skills[0]!.before, changes[0]!.skills[0]!.after], [0, 0]);

		const learn = courses.createCourseSession(course.id, "learn", skill);
		assert.ok(learn.ok);
		assert.equal(courses.ratingChanges(learn.value.id), null, "a lesson has its own result card");
		assert.equal(courses.ratingChanges("chat_nope"), null);
		assert.equal((await GET(new Request("http://x"), { params: Promise.resolve({ id: "chat_nope" }) })).status, 404);
	});
});

describe("the rating line", () => {
	const now = Date.parse("2026-11-13T12:00:00Z");
	const skill = (over: Partial<RatingChange["skills"][number]> = {}) => ({ id: "sk_a", name: "Product rule", before: 3.1, after: 4.2, reviewAt: "2026-11-18T12:00:00Z", ...over });

	it("reads 'understanding before → after · review in N days'", () => {
		assert.equal(ui.ratingLine(skill(), now), "Product rule: understanding 3.1 → 4.2 · review in 5 days");
		assert.equal(ui.ratingLine(skill({ reviewAt: "2026-11-14T00:00:00Z" }), now), "Product rule: understanding 3.1 → 4.2 · review tomorrow");
		assert.equal(ui.ratingLine(skill({ reviewAt: "2026-11-12T00:00:00Z" }), now), "Product rule: understanding 3.1 → 4.2 · review due now");
	});

	it("says so when nothing moved, or the skill is still not learned", () => {
		assert.equal(ui.ratingLine(skill({ after: 3.1 }), now), "Product rule: understanding stays 3.1 · review in 5 days");
		assert.equal(ui.ratingLine(skill({ before: 0, after: 0, reviewAt: null }), now), "Product rule: not learned yet");
	});
});
