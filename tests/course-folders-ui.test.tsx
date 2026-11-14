/**
 * COURSE FOLDERS in the sidebar (owner, 2026-11-14): the pure pieces of the UI — the exam countdown on a course's meta
 * line — and the inline folder rename. The interactions (menus, swipe, drag, collapse) are checked in a browser.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { CourseSummary } from "../src/core/contracts.ts";
import { examCountdownLabel } from "../src/core/exam-plan.ts";
import { FolderRenameRow } from "../components/course-folder-menus.tsx";
import { courseMeta } from "../components/courses-section.tsx";

const NOON = new Date(2026, 10, 14, 12, 0, 0).getTime();
const summary: CourseSummary = { id: "c1", title: "Matte", status: "active", total: 12, known: 7, progress: 58, needsReview: 2, updatedAt: "2026-11-14T00:00:00Z" } as CourseSummary;

describe("the exam countdown", () => {
	it("reads days, today, or passed", () => {
		assert.equal(examCountdownLabel("2026-11-26", NOON), "exam 12 d");
		assert.equal(examCountdownLabel("2026-11-15", NOON), "exam 1 d");
		assert.equal(examCountdownLabel("2026-11-14", NOON), "exam today");
		assert.equal(examCountdownLabel("2026-11-13", NOON), "exam passed");
	});

	it("ends a course's meta line, and only when it has an exam date", () => {
		assert.equal(courseMeta(summary, NOON), "7/12 known · 58% · 2 due");
		assert.equal(courseMeta({ ...summary, examDate: "2026-11-26" }, NOON), "7/12 known · 58% · 2 due · exam 12 d");
		assert.equal(courseMeta({ ...summary, status: "drafting", examDate: "2026-11-26" }, NOON), "Drafting skill map…");
	});
});

describe("the folder rename row", () => {
	it("is an input holding the folder's name", () => {
		const html = renderToStaticMarkup(<FolderRenameRow name="2026-2 Høst" onCommit={() => {}} onCancel={() => {}} />);
		assert.match(html, /data-testid="folder-rename-input"/);
		assert.match(html, /value="2026-2 Høst"/);
	});
});
