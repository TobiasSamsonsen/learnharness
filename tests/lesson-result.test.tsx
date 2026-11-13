/**
 * THE LESSON'S RESULT (owner, 2026-11-13): the summary the teacher gives when it finishes a lesson is kept as the
 * skill's note (read from the transcript, nothing stored), shown on the course page, handed to a later review as an
 * opening reminder, and shown under the finish divider with the skill's new understanding and the next steps.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lesson-result-"));
process.env.LH_DATA_DIR = TMP_DATA;

const session = await import("../src/core/course-session.ts");
const courses = await import("../src/server/courses.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { GET } = await import("../app/api/chats/[id]/lesson-result/route.ts");
const card = await import("../components/lesson-result-card.tsx");

import type { LhMessage } from "../src/core/native-messages.ts";
import type { LessonResult } from "../src/core";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const STAMPS = { api: "faux", provider: "test", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" };
let t = 1000;
const assistant = (content: unknown[]): LhMessage => ({ id: `m${t}`, role: "assistant", content, ...STAMPS, timestamp: t++ }) as unknown as LhMessage;
const result = (toolCallId: string, toolName: string, details: unknown = null, isError = false): LhMessage =>
	({ id: `m${t}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp: t++ }) as unknown as LhMessage;
const finish = (id: string, summary: unknown, isError = false): LhMessage[] => [
	assistant([{ type: "toolCall", id, name: "finish_lesson", arguments: { summary } }]),
	result(id, "finish_lesson", { grades: [] }, isError),
];

describe("finishSummaryOf", () => {
	it("is the summary of the clean finish_lesson call", () => {
		assert.equal(session.finishSummaryOf(finish("f1", "  Solved it alone. Practice signs.  "))?.summary, "Solved it alone. Practice signs.");
		assert.equal(session.finishSummaryOf([...finish("f1", "first"), ...finish("f2", "second")])?.summary, "first", "the first finish is the finish");
	});

	it("is null for an open lesson, a refused finish, a blank summary and the learner's old marker", () => {
		assert.equal(session.finishSummaryOf([]), null);
		assert.equal(session.finishSummaryOf(finish("f1", "x", true)), null);
		assert.equal(session.finishSummaryOf(finish("f1", "   ")), null);
		assert.equal(session.finishSummaryOf([{ ...session.newLessonFinishedMarker("practice"), timestamp: 5 } as LhMessage]), null);
	});
});

function lessonCourse() {
	const course = courseStore.createCourse("Calc");
	courseStore.updateCourse(course.id, {
		status: "draft",
		draft: { createdAt: "t", summary: "s", skills: [{ key: "s1", name: "Product rule", statement: "Do a", requires: [], restsOn: [] }, { key: "s2", name: "Chain rule", statement: "Do b", requires: [], restsOn: [] }] },
	});
	const approved = courses.approveCourse(course.id);
	assert.ok(approved.ok);
	const [a, b] = approved.value.skills as [string, string];
	const learn = courses.createCourseSession(course.id, "learn", a);
	assert.ok(learn.ok);
	return { courseId: course.id, a, b, chatId: learn.value.id };
}

describe("the lesson note and result", () => {
	it("the skill carries its lesson's note on the course view, and a later session is told", () => {
		const { courseId, a, chatId } = lessonCourse();
		assert.equal(courses.courseView(courseId)!.skills.find((s) => s.id === a)!.lessonNote, undefined, "no finish, no note");
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, ...finish("f1", "Applied the rule to three factors. Practice: signs.")]);
		const note = courses.courseView(courseId)!.skills.find((s) => s.id === a)!.lessonNote!;
		assert.equal(note.summary, "Applied the rule to three factors. Practice: signs.");
		assert.equal(note.chatId, chatId);
		const later = courses.createCourseSession(courseId, "practice", a);
		assert.ok(later.ok);
		const marker = chatStore.getChat(later.value.id)!.messages[0] as { content: string };
		assert.match(marker.content, /note from its last lesson: Applied the rule to three factors\. Practice: signs\./);
	});

	it("a lesson's own context carries no note (it is the lesson)", () => {
		const { courseId, chatId, a } = lessonCourse();
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, ...finish("f1", "A note.")]);
		const again = courses.createCourseSession(courseId, "learn", a);
		assert.ok(again.ok);
		assert.ok(!(chatStore.getChat(again.value.id)!.messages[0] as { content: string }).content.includes("note from its last lesson"));
	});

	it("the result route answers the skill, its understanding, the summary and the next skill", async () => {
		const { courseId, a, b, chatId } = lessonCourse();
		chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, ...finish("f1", "Solved the final problem unaided.")]);
		const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: chatId }) });
		assert.equal(res.status, 200);
		const body = (await res.json()) as LessonResult;
		assert.equal(body.courseId, courseId);
		assert.deepEqual(body.skill, { id: a, name: "Product rule" });
		assert.equal(body.learned, true);
		assert.ok(body.understanding > 0);
		assert.ok(body.reviewAt);
		assert.equal(body.summary, "Solved the final problem unaided.");
		assert.deepEqual(body.next, { id: b, name: "Chain rule" });
		assert.equal((await GET(new Request("http://x"), { params: Promise.resolve({ id: "chat_nope" }) })).status, 404);
		const practice = courses.createCourseSession(courseId, "practice", a);
		assert.ok(practice.ok);
		assert.equal((await GET(new Request("http://x"), { params: Promise.resolve({ id: practice.value.id }) })).status, 404, "only a Learn session has a result");
	});
});

describe("the result card", () => {
	const base: LessonResult = { courseId: "course_1", skill: { id: "sk_a", name: "Product rule" }, understanding: 3.1, learned: true, reviewAt: "2026-11-18T12:00:00Z", summary: "Solved it alone. Practice: signs.", next: { id: "sk_b", name: "Chain rule" } };
	const now = Date.parse("2026-11-13T12:00:00Z");
	const html = (over: Partial<LessonResult> = {}) => renderToStaticMarkup(<card.LessonResultView result={{ ...base, ...over }} now={now} onPractice={() => {}} onNext={() => {}} onCourse={() => {}} />);

	it("labels when the review comes", () => {
		assert.equal(card.reviewInLabel("2026-11-18T12:00:00Z", now), "review in 5 days");
		assert.equal(card.reviewInLabel("2026-11-14T00:00:00Z", now), "review tomorrow");
		assert.equal(card.reviewInLabel("2026-11-12T00:00:00Z", now), "due for review now");
		assert.equal(card.reviewInLabel(null, now), null);
	});

	it("shows the skill, its understanding and review date, the summary and the three next steps", () => {
		const out = html();
		assert.match(out, /Product rule/);
		assert.match(out, /Understanding 3\.1\/10 · review in 5 days/);
		assert.match(out, /Solved it alone\./);
		assert.match(out, />Practice this skill</);
		assert.match(out, />Next: Chain rule</);
		assert.match(out, />Back to the course</);
	});

	it("leaves out what it does not have", () => {
		const out = html({ next: null, summary: null, reviewAt: null });
		assert.ok(!out.includes("lesson-result-next"));
		assert.ok(!out.includes("lesson-result-summary"));
		assert.match(out, /Understanding 3\.1\/10</);
		assert.ok(!out.includes("review in"));
	});
});
