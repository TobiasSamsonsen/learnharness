/**
 * The "Learn <skill>" buttons on a concluded review/practice problem
 * (owner goal, 2026-11-07): the pure helper that picks the again-graded
 * skills, the concluded card's render contract, and the course-skills route
 * that feeds the buttons' labels. Deterministic: LH_DATA_DIR isolates.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learn-skill-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { ConcludeCard, learnableSkillIds } = await import("../components/practice-cards.tsx");
const { ChatActionsContext } = await import("../components/chat.tsx");
const { courseStore } = await import("../src/store/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const courses = await import("../src/server/courses.ts");
const { GET } = await import("../app/api/chats/[id]/course/route.ts");

import type { ArtifactPartProps } from "../src/core";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const part = (input: Record<string, unknown>): ArtifactPartProps["part"] => ({
	type: "tool-conclude",
	state: "input-available",
	toolCallId: "call_c1",
	input,
});

const ctx = {
	chatId: "chat_1",
	syncFromServer: async () => {},
	sendText: () => {},
	openSetup: () => {},
};

// ─── the pure helper ────────────────────────────────────────────────────────

describe("learnableSkillIds", () => {
	it("solved never offers a Learn button", () => {
		assert.deepEqual(learnableSkillIds({ outcome: "solved", grades: [{ skill: "sk_a", grade: "again" }] }), []);
	});

	it("taught, movedOn and surrendered offer the again-graded skills", () => {
		const grades = [
			{ skill: "sk_a", grade: "again" },
			{ skill: "sk_b", grade: "good" },
			{ skill: "sk_c", grade: "again" },
		];
		for (const outcome of ["taught", "movedOn", "surrendered"]) {
			assert.deepEqual(learnableSkillIds({ outcome, grades }), ["sk_a", "sk_c"], outcome);
		}
	});

	it("only good or hard grades offer nothing", () => {
		assert.deepEqual(
			learnableSkillIds({
				outcome: "taught",
				grades: [
					{ skill: "sk_a", grade: "good" },
					{ skill: "sk_b", grade: "hard" },
				],
			}),
			[],
		);
	});

	it("malformed grades offer nothing", () => {
		assert.deepEqual(learnableSkillIds({ outcome: "taught", grades: "again" }), []);
		assert.deepEqual(learnableSkillIds({ outcome: "taught", grades: null }), []);
		assert.deepEqual(learnableSkillIds({ outcome: "taught" }), []);
		assert.deepEqual(learnableSkillIds({ outcome: "taught", grades: [null, 3, { skill: 7, grade: "again" }, { grade: "again" }] }), []);
	});

	it("a repeated skill is offered once", () => {
		assert.deepEqual(
			learnableSkillIds({
				outcome: "taught",
				grades: [
					{ skill: "sk_a", grade: "again" },
					{ skill: "sk_a", grade: "again" },
				],
			}),
			["sk_a"],
		);
	});
});

// ─── the concluded card ─────────────────────────────────────────────────────

describe("ConcludeCard with Learn buttons", () => {
	it("renders without throwing when taught has an again grade, inside a chat; buttons arrive only after the client fetch", () => {
		const html = renderToStaticMarkup(
			<ChatActionsContext.Provider value={ctx}>
				<ConcludeCard part={part({ outcome: "taught", verdict: "v", grades: [{ skill: "sk_a", grade: "again" }] })} />
			</ChatActionsContext.Provider>,
		);
		assert.match(html, /data-testid="conclude-card"/);
		assert.doesNotMatch(html, /data-testid="learn-skill-/, "no server-side fetch, so no buttons yet");
	});

	it("renders no Learn button for solved, or without an again grade", () => {
		const solved = renderToStaticMarkup(
			<ChatActionsContext.Provider value={ctx}>
				<ConcludeCard part={part({ outcome: "solved", grades: [{ skill: "sk_a", grade: "again" }] })} />
			</ChatActionsContext.Provider>,
		);
		assert.doesNotMatch(solved, /learn-skill-/);
		const good = renderToStaticMarkup(
			<ChatActionsContext.Provider value={ctx}>
				<ConcludeCard part={part({ outcome: "taught", grades: [{ skill: "sk_a", grade: "good" }] })} />
			</ChatActionsContext.Provider>,
		);
		assert.doesNotMatch(good, /learn-skill-/);
	});
});

// ─── the course-skills route ────────────────────────────────────────────────

describe("GET /api/chats/[id]/course", () => {
	beforeEach(() => {
		for (const c of courseStore.listCourses()) courseStore.deleteCourse(c.id);
		for (const c of chatStore.listChats()) chatStore.deleteChat(c.id);
	});

	const call = (id: string) => GET(new Request(`http://localhost/api/chats/${id}/course`), { params: Promise.resolve({ id }) });

	it("404 for an unknown chat and for a learn-mode course session", async () => {
		const unknown = await call("chat_nope");
		assert.equal(unknown.status, 404);
		assert.ok(((await unknown.json()) as { error?: unknown }).error);

		const course = courseStore.createCourse("Calc");
		courseStore.updateCourse(course.id, {
			status: "draft",
			draft: {
				createdAt: "t",
				summary: "s",
				skills: [
					{ key: "s1", name: "A", statement: "Do a", requires: [], restsOn: [] },
					{ key: "s2", name: "B", statement: "Do b", requires: ["s1"], restsOn: [] },
				],
			},
		});
		const approved = courses.approveCourse(course.id);
		assert.ok(approved.ok);
		const [a, b] = approved.value.skills;
		const learn = courses.createCourseSession(course.id, "learn", b!);
		assert.ok(learn.ok);
		const learnRes = await call(learn.value.id);
		assert.equal(learnRes.status, 404);

		// a practice session on skill a is a practice course session: its course and skill names
		const practice = courses.createCourseSession(course.id, "practice", a!);
		assert.ok(practice.ok);
		const res = await call(practice.value.id);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { courseId: course.id, skills: [{ id: a, name: "A" }] });
	});
});
