/**
 * COURSE FOLDERS in the sidebar (owner, 2026-11-14): the pure pieces of the UI — the exam countdown on a course's meta
 * line — and the inline folder rename. The interactions (menus, swipe, drag, collapse) are checked in a browser.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { CourseSummary } from "../src/core/contracts.ts";
import { examDaysLabel } from "../src/core/exam-plan.ts";
import { FolderRenameRow } from "../components/course-folder-menus.tsx";
import { courseMeta, courseMetaParts } from "../components/courses-section.tsx";

const NOON = new Date(2026, 10, 14, 12, 0, 0).getTime();
const summary: CourseSummary = { id: "c1", title: "Matte", status: "active", total: 12, known: 7, progress: 58, needsReview: 2, updatedAt: "2026-11-14T00:00:00Z" } as CourseSummary;

describe("the exam countdown", () => {
	it("reads days, today, or passed", () => {
		assert.equal(examDaysLabel("2026-11-26", NOON), "12 d");
		assert.equal(examDaysLabel("2026-11-15", NOON), "1 d");
		assert.equal(examDaysLabel("2026-11-14", NOON), "today");
		assert.equal(examDaysLabel("2026-11-13", NOON), "passed");
	});

	it("puts percent, days and due on a course's meta line, days only with an exam date and due only above 0", () => {
		assert.equal(courseMeta(summary, NOON), "58% · 2 due");
		assert.equal(courseMeta({ ...summary, examDate: "2026-11-26" }, NOON), "58% · 12 d · 2 due");
		assert.equal(courseMeta({ ...summary, examDate: "2026-11-26", needsReview: 0 }, NOON), "58% · 12 d");
		assert.equal(courseMeta({ ...summary, examDate: "2026-11-14", needsReview: 0 }, NOON), "58% · today");
		assert.equal(courseMeta({ ...summary, examDate: "2026-11-13", needsReview: 0 }, NOON), "58% · passed");
	});

	it("keeps the columns: no exam date leaves the days column empty, so the due count stays last", () => {
		assert.deepEqual(courseMetaParts(summary, NOON), { status: null, percent: "58%", days: null, due: "2 due" });
		assert.deepEqual(courseMetaParts({ ...summary, examDate: "2026-11-26" }, NOON), { status: null, percent: "58%", days: "12 d", due: "2 due" });
	});

	it("shows the skill map's status instead while it is drafting, failed or waiting, and nothing before one exists", () => {
		assert.equal(courseMeta({ ...summary, status: "drafting", examDate: "2026-11-26" }, NOON), "drafting…");
		assert.equal(courseMeta({ ...summary, total: 0, known: 0, progress: 0, needsReview: 0, status: "draft" }, NOON), "Draft ready to review");
		assert.equal(courseMeta({ ...summary, total: 0, known: 0, progress: 0, needsReview: 0, status: "error" }, NOON), "Drafting failed");
		assert.equal(courseMeta({ ...summary, total: 0, known: 0, progress: 0, needsReview: 0, status: "active" }, NOON), "");
	});
});

describe("the folder rename row", () => {
	it("is an input holding the folder's name", () => {
		const html = renderToStaticMarkup(<FolderRenameRow name="2026-2 Høst" onCommit={() => {}} onCancel={() => {}} />);
		assert.match(html, /data-testid="folder-rename-input"/);
		assert.match(html, /value="2026-2 Høst"/);
	});
});
