/**
 * The closed "Course settings" line under the course page's header (owner, 2026-11-14): what it holds, and when it opens
 * by itself.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CourseSettings } from "../components/course-settings.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers";

const base = {
	courseId: "course_1",
	pace: undefined,
	hasSkills: true,
	hasDraft: false,
	drafting: false,
	error: null,
	materialCount: 2,
	busy: false,
	onDraft: () => {},
	onPlacement: () => {},
	exam: { examDate: "2026-12-14", hasWeights: true, weighing: false, canWeigh: true },
};

const render = (over: Record<string, unknown> = {}) => renderToStaticMarkup(
	<InteractionLayersProvider>
		<CourseSettings {...base} {...over} />
	</InteractionLayersProvider>,
);
const isOpen = (html: string) => /<details[^>]*\sopen=""/.test(html);

describe("the course settings", () => {
	it("is one closed line once the course has a skill map", () => {
		const html = render();
		assert.match(html, /Course settings/);
		assert.equal(isOpen(html), false);
	});

	it("holds the pace, the curriculum, the exam and the placement test", () => {
		const html = render();
		assert.match(html, /data-testid="course-pace-select"/);
		assert.match(html, /data-testid="course-curriculum"/);
		assert.match(html, /data-testid="course-draft-button"[^>]*>Re-draft skill map</);
		assert.match(html, /data-testid="course-exam-settings"/);
		assert.match(html, /data-testid="course-placement"[^>]*>\s*Placement test/);
	});

	it("opens by itself while the skill map is missing, drafting, failed or waiting for review", () => {
		assert.equal(isOpen(render({ hasSkills: false, exam: undefined })), true, "no skill map yet");
		assert.equal(isOpen(render({ drafting: true })), true, "drafting");
		assert.equal(isOpen(render({ courseError: "no credit" })), true, "failed");
		assert.equal(isOpen(render({ hasDraft: true })), true, "a draft to review");
	});

	it("without a skill map it offers Draft skill map and no exam or placement test", () => {
		const html = render({ hasSkills: false, exam: undefined });
		assert.match(html, /data-testid="course-draft-button"[^>]*>Draft skill map</);
		assert.doesNotMatch(html, /course-exam-settings|course-placement/);
	});

	it("shows the drafting status on the closed line, and a failure with its reason", () => {
		assert.match(render({ drafting: true }), /data-testid="course-drafting"/);
		assert.match(render({ courseError: "no credit" }), /Drafting failed: no credit/);
	});

	it("says to add the curriculum first when there are no sources", () => {
		assert.match(render({ materialCount: 0 }), /Add the curriculum/);
	});

	it("has no time note field any more", () => {
		assert.doesNotMatch(render(), /course-time-note/);
	});
});
